/**
 * api-requirement-grounding.service
 * ─────────────────────────────────
 * Assembles a concise, text grounding block from the structured requirement
 * records the tenant already stored through the BRD / FRD surfaces, so the
 * API-automation generator can be grounded in real acceptance criteria,
 * business rules and FR→endpoint mappings — not just free-text.
 *
 * This is the server-side wire that was missing: the BRD/FRD acceptance
 * criteria lived in `business_requirements` / `functional_requirements` and
 * were surfaced in the UI + traceability matrix, but never reached
 * `buildApiPrompt`. Here we read them back (tenant-scoped, via the existing
 * services) and compose a bounded grounding string.
 *
 * Deterministic and token-free — no LLM call. The requirementAgent (an LLM
 * stage) then parses the assembled text into structured requirements.
 */
import { getBrdDocument } from './api-brd.service.js';
import { getFrdDocument } from './api-frd.service.js';

/** Which stored requirement documents to fold into the generation grounding. */
export interface RequirementRefs {
  brdDocIds?: string[];
  frdDocIds?: string[];
}

const MAX_DOCS = 10;          // per kind
const MAX_REQS_PER_DOC = 40;
const MAX_ITEMS = 8;          // per list on a single requirement
const MAX_TOTAL = 6000;       // final grounding length cap (chars)

function clip(list: string[] | undefined, n: number): string[] {
  return (list || []).map((s) => String(s).trim()).filter(Boolean).slice(0, n);
}

/** True when the refs carry at least one document id. */
export function hasRequirementRefs(refs: RequirementRefs | null | undefined): boolean {
  return !!refs && ((refs.brdDocIds?.length || 0) + (refs.frdDocIds?.length || 0) > 0);
}

/**
 * Read the referenced BRD/FRD documents for this tenant and compose a bounded
 * grounding string (acceptance criteria + business rules + FR→endpoint maps).
 * Returns '' when nothing resolves — callers then fall back to free text only.
 */
export async function assembleRequirementGrounding(
  tenantId: string,
  refs: RequirementRefs | null | undefined,
): Promise<string> {
  if (!hasRequirementRefs(refs)) return '';
  const blocks: string[] = [];

  for (const id of (refs!.brdDocIds || []).slice(0, MAX_DOCS)) {
    let doc;
    try { doc = await getBrdDocument(tenantId, id); } catch { doc = null; }
    if (!doc) continue;
    const lines: string[] = [];
    for (const r of doc.requirements.slice(0, MAX_REQS_PER_DOC)) {
      const seg: string[] = [`- ${[r.brId, r.title].filter(Boolean).join(': ')}`.trim()];
      if (r.description) seg.push(`    ${r.description.slice(0, 400)}`);
      const rules = clip(r.rules, MAX_ITEMS);
      if (rules.length) seg.push(`    Business rules: ${rules.join('; ')}`);
      const ac = clip(r.acceptanceCriteria, MAX_ITEMS);
      if (ac.length) seg.push(`    Acceptance criteria: ${ac.join(' | ')}`);
      lines.push(seg.join('\n'));
    }
    if (lines.length) blocks.push(`BUSINESS REQUIREMENTS — ${doc.document.name || id}:\n${lines.join('\n')}`);
  }

  for (const id of (refs!.frdDocIds || []).slice(0, MAX_DOCS)) {
    let doc;
    try { doc = await getFrdDocument(tenantId, id); } catch { doc = null; }
    if (!doc) continue;
    const lines: string[] = [];
    for (const r of doc.requirements.slice(0, MAX_REQS_PER_DOC)) {
      const seg: string[] = [`- ${[r.frId, r.title].filter(Boolean).join(': ')}`.trim()];
      if (r.description) seg.push(`    ${r.description.slice(0, 400)}`);
      const eps = (r.endpoints || []).slice(0, MAX_ITEMS)
        .map((e) => `${(e.method || '').toUpperCase()} ${e.path || ''}`.trim())
        .filter(Boolean);
      if (eps.length) seg.push(`    Endpoints: ${eps.join(', ')}`);
      const resp = (r.responses || []).slice(0, MAX_ITEMS)
        .map((x) => `${x.status}${x.description ? ` ${x.description}` : ''}`.trim())
        .filter(Boolean);
      if (resp.length) seg.push(`    Expected responses: ${resp.join('; ')}`);
      const ac = clip(r.acceptanceCriteria, MAX_ITEMS);
      if (ac.length) seg.push(`    Acceptance criteria: ${ac.join(' | ')}`);
      lines.push(seg.join('\n'));
    }
    if (lines.length) blocks.push(`FUNCTIONAL REQUIREMENTS — ${doc.document.name || id}:\n${lines.join('\n')}`);
  }

  return blocks.join('\n\n').slice(0, MAX_TOTAL);
}
