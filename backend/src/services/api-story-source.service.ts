/**
 * api-story-source.service.ts
 * ───────────────────────────
 * Answers "where did this requirement come from?" for the story agent's
 * checklist item *each requirement links back to its source (spec section or
 * Jira key)*.
 *
 * Three tiers, in descending order of authority:
 *   1. a Jira key written in the story text, verified against the tenant's Jira
 *   2. a test-management key (TestRail, Xray, Zephyr Scale, qTest) matched
 *      against the cases that connector actually holds
 *   3. the endpoint's own import origin — the OpenAPI section, the Postman
 *      collection, the cURL command it was pasted from
 *
 * Every tier is DERIVED: keys are read out of the text the user supplied and
 * confirmed at their source, and the import origin comes off the catalogue
 * record. The model is never asked where a requirement came from, so it can
 * never invent an issue key — traceability that could be hallucinated would be
 * worth nothing.
 *
 * Tiers 1 and 2 cross the network and are best-effort: a connector that is down
 * downgrades a key to "named in the story, unverified" rather than failing the
 * generation. Tier 3 is local and always available.
 */
import { getCredsForTenant, getStory } from './jira.service.js';
import { getCredsForTenant as getAdoCredsForTenant, getStory as getAdoStory } from './azure-devops.service.js';
import { listConnectors, importCases, VENDOR_LABELS, type TmVendor } from './api-tm-connectors.service.js';

export type SourceKind = 'jira' | TmVendor | 'import';

export interface ReqSourceRef {
  kind: SourceKind;
  /** What the chip reads: "Jira", "qTest", "OpenAPI". */
  label: string;
  /** The key or pointer itself: "PROJ-120", "createOrder", "POST /v1/orders". */
  ref: string;
  /** Where a person can go to read it, when the source has an address. */
  url?: string;
  /** True once the ref was confirmed to exist at its source. */
  verified: boolean;
  /** One line of context — the story title, the case title, the import name. */
  detail?: string;
}

/**
 * Jira and every test-management vendor here use the same PROJ-123 shape, so
 * one scan finds candidates for both and each tier claims what it recognises.
 */
const KEY_RE = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g;
const MAX_KEYS = 10;
/** Enough to cover a working project without turning this into a sync. */
const TM_CASE_SCAN = 200;

/** Distinct external keys written in the story text, in the order they appear. */
export function keysInStory(storyText: string): string[] {
  const out = new Set<string>();
  for (const m of String(storyText || '').matchAll(KEY_RE)) {
    out.add(m[1]);
    if (out.size >= MAX_KEYS) break;
  }
  return [...out];
}

/** Tier 1 — confirm each key against the tenant's Jira. */
async function fromJira(tenantId: string, keys: string[]): Promise<ReqSourceRef[]> {
  if (!keys.length) return [];
  const creds = await getCredsForTenant(tenantId).catch(() => null);
  if (!creds) return [];

  const refs: ReqSourceRef[] = [];
  for (const key of keys) {
    try {
      const story = await getStory(creds, key);
      refs.push({
        kind: 'jira',
        label: 'Jira',
        ref: story.key || key,
        url: `${creds.baseUrl}/browse/${encodeURIComponent(key)}`,
        verified: true,
        detail: story.title ? String(story.title).slice(0, 160) : undefined,
      });
    } catch {
      // Not a Jira issue, or Jira is unreachable — another tier may claim it.
    }
  }
  return refs;
}

/** Tier 2 — match each remaining key against what the TM connectors hold. */
async function fromTestManagement(tenantId: string, keys: string[]): Promise<ReqSourceRef[]> {
  if (!keys.length) return [];
  const connectors = await listConnectors(tenantId).catch(() => []);
  const live = connectors.filter((c) => c.enabled);
  if (!live.length) return [];

  const wanted = new Set(keys.map((k) => k.toUpperCase()));
  const refs: ReqSourceRef[] = [];

  for (const c of live) {
    if (!wanted.size) break;
    try {
      const { cases } = await importCases(tenantId, c.id, TM_CASE_SCAN);
      for (const kase of cases) {
        const id = String(kase.externalId || '').toUpperCase();
        if (!wanted.has(id)) continue;
        wanted.delete(id);
        refs.push({
          kind: c.vendor,
          label: VENDOR_LABELS[c.vendor] || c.vendor,
          ref: kase.externalId,
          verified: true,
          detail: kase.title ? String(kase.title).slice(0, 160) : undefined,
        });
      }
    } catch {
      // A connector that is down simply claims nothing.
    }
  }
  return refs;
}

/**
 * Every external reference the story text points at, verified where the tenant
 * has a connection to check it against. Keys nobody could confirm come back
 * marked unverified rather than being dropped — the user wrote them, so they
 * are still the stated source; the UI says they could not be checked.
 */
export async function resolveStorySources(tenantId: string, storyText: string): Promise<ReqSourceRef[]> {
  const keys = keysInStory(storyText);
  if (!keys.length) return [];

  const jira = await fromJira(tenantId, keys);
  const claimed = new Set(jira.map((r) => r.ref.toUpperCase()));
  const tm = await fromTestManagement(tenantId, keys.filter((k) => !claimed.has(k.toUpperCase())));
  for (const r of tm) claimed.add(r.ref.toUpperCase());

  const unverified: ReqSourceRef[] = keys
    .filter((k) => !claimed.has(k.toUpperCase()))
    .map((k) => ({
      kind: 'jira',
      label: 'Key in story',
      ref: k,
      verified: false,
      detail: 'Named in the story, but no connected tool could confirm it.',
    }));

  return [...jira, ...tm, ...unverified];
}

/** Where a story was explicitly loaded from in the UI (a pull-in, not a key scan). */
export type StoryOriginKind = 'jira' | 'ado' | 'document';
export interface StoryOrigin { kind: StoryOriginKind; ref: string; label?: string }

/**
 * Resolve the source for a story the reviewer LOADED from a connected tool or an
 * uploaded document, rather than one whose key was scanned out of pasted text.
 * It is still verified at its source here — the UI only says which tool and id to
 * check, never asserts the link itself — so the "a source is never taken on the
 * client's word" guarantee holds for pull-ins too. A Jira/ADO ref that cannot be
 * re-confirmed comes back unverified rather than being dropped; an uploaded
 * document stands as its own source (the user supplied the file directly).
 */
export async function resolveOrigin(tenantId: string, origin?: StoryOrigin | null): Promise<ReqSourceRef | null> {
  const ref = String(origin?.ref || '').trim();
  if (!origin || !ref) return null;

  if (origin.kind === 'jira') {
    const creds = await getCredsForTenant(tenantId).catch(() => null);
    if (creds) {
      try {
        const story = await getStory(creds, ref);
        return { kind: 'jira', label: 'Jira', ref: story.key || ref, url: `${creds.baseUrl}/browse/${encodeURIComponent(ref)}`, verified: true, detail: story.title ? String(story.title).slice(0, 160) : undefined };
      } catch { /* fall through to unverified */ }
    }
    return { kind: 'jira', label: 'Jira', ref, verified: false, detail: 'Loaded from Jira, but it could not be re-confirmed.' };
  }

  if (origin.kind === 'ado') {
    const creds = await getAdoCredsForTenant(tenantId).catch(() => null);
    if (creds) {
      try {
        const wi = await getAdoStory(creds, ref);
        const url = `${creds.baseUrl}/${encodeURIComponent(creds.project)}/_workitems/edit/${encodeURIComponent(ref)}`;
        return { kind: 'import', label: 'Azure DevOps', ref: wi.key || ref, url, verified: true, detail: wi.title ? String(wi.title).slice(0, 160) : undefined };
      } catch { /* fall through to unverified */ }
    }
    return { kind: 'import', label: 'Azure DevOps', ref, verified: false, detail: 'Loaded from Azure DevOps, but it could not be re-confirmed.' };
  }

  // A document the user uploaded: no re-checkable address, but a real, directly
  // supplied source — so it stands as its own verified origin (its file name).
  return { kind: 'import', label: 'Document', ref: ref.slice(0, 200), verified: true, detail: 'Loaded from an uploaded requirement document.' };
}

/**
 * Tier 3 — the endpoint's own import origin, which exists for anything that
 * came through an import. `operationId` is the precise spec pointer when the
 * document carried one; otherwise the method and path identify the operation.
 */
export function importOriginOf(e: { method?: string; url?: string; operationId?: string; source?: { method?: string; name?: string } }): ReqSourceRef | null {
  if (!e?.source?.method) return null;
  const kind = String(e.source.method);
  let path = e.url || '';
  try { path = new URL(String(e.url)).pathname; } catch { /* a relative URL is already a path */ }
  const ref = (e.operationId && e.operationId.trim())
    ? e.operationId.trim().slice(0, 200)
    : `${String(e.method || 'GET').toUpperCase()} ${path}`.slice(0, 200);
  return {
    kind: 'import',
    label: IMPORT_LABELS[kind] || kind,
    ref,
    verified: true,
    detail: e.source.name ? String(e.source.name).slice(0, 160) : undefined,
  };
}

/** Import-method ids → how the catalogue names them to a person. */
const IMPORT_LABELS: Record<string, string> = {
  openapi: 'OpenAPI', swagger: 'Swagger', postman: 'Postman', bruno: 'Bruno',
  har: 'HAR', curl: 'cURL', wsdl: 'WSDL', graphql: 'GraphQL', grpc: 'gRPC',
  sdk: 'SDK', docs: 'API docs', mcp: 'MCP server', webhook: 'Webhook',
  middleware: 'Middleware', manual: 'Manual request', url: 'Live URL',
  connector: 'Custom connector', pdf: 'PDF', word: 'Word', excel: 'Excel',
  markdown: 'Markdown', code: 'Source code',
};
