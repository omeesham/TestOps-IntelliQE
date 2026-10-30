/**
 * requirement-review.ts — Gap B: deterministic human-review flags for extracted
 * requirements (BRD business requirements and FRD functional requirements).
 *
 * Flags are DERIVED (not stored), so no migration is needed and they always
 * reflect the current requirement text. Three kinds, matching the spec:
 *   - incomplete : a requirement missing the parts that make it testable
 *   - ambiguous  : vague wording that needs clarification before automating
 *   - conflict   : a duplicate id, or the same endpoint claimed by two FRs
 * Everything here is pure string/array inspection — verifiable and never flaky.
 */

export interface ReviewFlag { code: 'incomplete' | 'ambiguous' | 'conflict'; message: string }

// Words/markers that signal an under-specified requirement.
const VAGUE = /\b(tbd|tbc|to be decided|to be determined|etc\.?|and\/or|as needed|as appropriate|appropriate(ly)?|various|several|some|many|maybe|possibly|if necessary|where applicable|and so on)\b/i;

function hasVague(...parts: (string | undefined)[]): boolean {
  const blob = parts.filter(Boolean).join(' ');
  return VAGUE.test(blob) || /\?\s*$/.test(blob.trim());
}

/** Business-requirement flags, including cross-set duplicate-id detection. */
export function annotateBrReviewFlags<T extends { brId: string; title: string; description?: string; rules?: string[]; acceptanceCriteria?: string[] }>(reqs: T[]): (T & { reviewFlags: ReviewFlag[] })[] {
  const idCounts = new Map<string, number>();
  for (const r of reqs) idCounts.set(r.brId, (idCounts.get(r.brId) || 0) + 1);

  return reqs.map((r) => {
    const flags: ReviewFlag[] = [];
    if ((!r.acceptanceCriteria || r.acceptanceCriteria.length === 0) && (!r.rules || r.rules.length === 0)) {
      flags.push({ code: 'incomplete', message: 'No acceptance criteria or business rules — may be untestable.' });
    }
    if (!r.description || r.description.trim().length < 15) {
      flags.push({ code: 'incomplete', message: 'Very little detail provided.' });
    }
    if (hasVague(r.title, r.description)) {
      flags.push({ code: 'ambiguous', message: 'Vague wording — clarify before automating.' });
    }
    if ((idCounts.get(r.brId) || 0) > 1) {
      flags.push({ code: 'conflict', message: `Duplicate requirement id ${r.brId}.` });
    }
    return { ...r, reviewFlags: flags };
  });
}

interface FrLike { frId: string; title: string; description?: string; endpoints?: { method: string; path: string }[]; responses?: unknown[]; acceptanceCriteria?: string[] }

/** Functional-requirement flags, including duplicate-id and duplicate-endpoint conflicts. */
export function annotateFrReviewFlags<T extends FrLike>(reqs: T[]): (T & { reviewFlags: ReviewFlag[] })[] {
  const idCounts = new Map<string, number>();
  const epOwners = new Map<string, string[]>(); // "METHOD path" → [frId]
  for (const r of reqs) {
    idCounts.set(r.frId, (idCounts.get(r.frId) || 0) + 1);
    for (const e of r.endpoints || []) {
      const sig = `${String(e.method || '').toUpperCase()} ${String(e.path || '').trim().toLowerCase()}`.trim();
      if (!sig) continue;
      const arr = epOwners.get(sig) || []; if (!arr.includes(r.frId)) arr.push(r.frId); epOwners.set(sig, arr);
    }
  }

  return reqs.map((r) => {
    const flags: ReviewFlag[] = [];
    if (!r.endpoints || r.endpoints.length === 0) {
      flags.push({ code: 'incomplete', message: 'No API endpoint identified for this requirement.' });
    }
    if (!r.responses || r.responses.length === 0) {
      flags.push({ code: 'incomplete', message: 'No expected responses defined.' });
    }
    if (hasVague(r.title, r.description)) {
      flags.push({ code: 'ambiguous', message: 'Vague wording — clarify before automating.' });
    }
    if ((idCounts.get(r.frId) || 0) > 1) {
      flags.push({ code: 'conflict', message: `Duplicate requirement id ${r.frId}.` });
    }
    for (const e of r.endpoints || []) {
      const sig = `${String(e.method || '').toUpperCase()} ${String(e.path || '').trim().toLowerCase()}`.trim();
      const owners = epOwners.get(sig) || [];
      if (owners.length > 1) { flags.push({ code: 'conflict', message: `Endpoint ${e.method} ${e.path} also claimed by ${owners.filter((o) => o !== r.frId).join(', ')}.` }); break; }
    }
    return { ...r, reviewFlags: flags };
  });
}
