/**
 * api-evidence.service.ts
 * ───────────────────────
 * Compliance-evidence export. Assembles a single audit-ready document for one
 * API run — the run summary + pass/fail stats, the compliance posture (reusing
 * the compliance packs), the run sign-off thread, and the multi-stage approval
 * status — and renders it as a real PDF (via pdf-lib) or, if that library isn't
 * installed, a print-ready HTML document the browser can "Save as PDF".
 *
 * Additive and read-only: it reads existing reports/reviews/approvals and
 * produces a file; it writes nothing and touches nothing in the pipeline.
 */
import { getApiRunDetail } from './api-dashboard.service.js';
import { runCompliancePack, listCompliancePacks, type ComplianceEndpoint } from './api-compliance.service.js';
import { listReviews } from './api-reviews.service.js';
import { evaluateApprovalGate, type ApprovalGate } from './api-approvals.service.js';

export interface EvidenceDoc {
  generatedAt: string;
  run: {
    runId: string; title: string; createdAt: string; createdBy: string; reportUrl?: string; caseCount: number;
    stats: { total: number; passed: number; failed: number; broken: number; passRate: number; durationMs: number } | null;
  };
  compliance: { pack: string; label: string; grade: string; score: number; summary: Record<string, number> }[];
  failures: { id: string; title: string; error?: string }[];
  signoff: { status: string | null; count: number; latest?: { decision: string; reviewer?: string; note?: string; at: string } };
  approval: ApprovalGate;
}

export async function buildEvidence(tenantId: string, input: { runId: string; standards?: string[] }): Promise<EvidenceDoc> {
  const runId = String(input?.runId || '');
  if (!runId) throw new Error('A run is required.');
  const detail = await getApiRunDetail(tenantId, runId);
  if (!detail) throw new Error('Run not found.');

  const eps: ComplianceEndpoint[] = [];
  const seen = new Set<string>();
  for (const c of detail.cases) {
    const api = c.api && typeof c.api === 'object' ? c.api : null;
    if (!api?.endpoint) continue;
    const key = `${api.method || 'GET'} ${api.endpoint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    eps.push({ method: String(api.method || 'GET'), url: String(api.endpoint) });
  }

  const available = new Set(listCompliancePacks().map((p) => p.id));
  const wanted = (Array.isArray(input?.standards) && input.standards.length ? input.standards : [...available]).filter((s) => available.has(s));
  const compliance = wanted.map((pack) => {
    const r = runCompliancePack(pack, eps);
    return { pack: r.pack, label: r.packLabel, grade: r.grade, score: r.score, summary: r.summary as Record<string, number> };
  });

  const failures = detail.cases
    .filter((c) => c.status === 'failed' || c.status === 'broken')
    .slice(0, 200)
    .map((c) => ({ id: c.id, title: c.title, error: c.error }));

  const thread = await listReviews(tenantId, runId);
  const latest = thread.reviews[0];
  const approval = await evaluateApprovalGate(tenantId, runId);

  return {
    generatedAt: new Date().toISOString(),
    run: {
      runId: detail.runId, title: detail.title, createdAt: detail.createdAt, createdBy: detail.createdBy,
      reportUrl: detail.reportUrl, caseCount: detail.caseCount,
      stats: detail.stats ? {
        total: detail.stats.total, passed: detail.stats.passed, failed: detail.stats.failed,
        broken: detail.stats.broken, passRate: detail.stats.passRate, durationMs: detail.stats.durationMs,
      } : null,
    },
    compliance,
    failures,
    signoff: { status: thread.status, count: thread.reviews.length, latest: latest ? { decision: latest.decision, reviewer: latest.reviewer, note: latest.note, at: latest.createdAt } : undefined },
    approval,
  };
}

// ─── rendering ──────────────────────────────────────────────────────────────

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]!));
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

export function renderEvidenceHtml(doc: EvidenceDoc): string {
  const s = doc.run.stats;
  const rows = doc.compliance.map((c) =>
    `<tr><td>${esc(c.label)}</td><td class="g g-${esc(c.grade)}">${esc(c.grade)}</td><td>${c.score}%</td>
       <td>${c.summary.pass || 0} pass · ${c.summary.warn || 0} warn · ${c.summary.fail || 0} fail · ${c.summary.review || 0} review</td></tr>`).join('');
  const fails = doc.failures.length
    ? `<ul>${doc.failures.map((f) => `<li><b>${esc(f.id)}</b> ${esc(f.title)}${f.error ? ` — <span class="err">${esc(f.error)}</span>` : ''}</li>`).join('')}</ul>`
    : '<p class="ok">No failing cases.</p>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Evidence — ${esc(doc.run.title)}</title>
<style>
  :root{color-scheme:light}
  body{font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1e293b;max-width:860px;margin:32px auto;padding:0 24px}
  h1{font-size:22px;margin:0 0 4px} h2{font-size:15px;margin:26px 0 8px;border-bottom:1px solid #e2e8f0;padding-bottom:4px}
  .muted{color:#64748b;font-size:12px} table{border-collapse:collapse;width:100%;margin-top:6px}
  th,td{border:1px solid #e2e8f0;padding:6px 8px;text-align:left;font-size:12px} th{background:#f8fafc}
  .kpi{display:inline-block;margin-right:18px}.kpi b{font-size:20px;display:block}
  .g{font-weight:700;text-align:center}.g-A{color:#15803d}.g-B{color:#16a34a}.g-C{color:#ca8a04}.g-D{color:#ea580c}.g-F{color:#dc2626}
  .err{color:#dc2626}.ok{color:#15803d} .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}
  @media print{body{margin:0}}
</style></head><body>
<h1>Compliance Evidence</h1>
<p class="muted">${esc(doc.run.title)} · run ${esc(doc.run.runId)} · generated ${esc(doc.generatedAt)}</p>
<h2>Run summary</h2>
<div>
  <span class="kpi"><b>${s ? s.passRate : '—'}${s ? '%' : ''}</b>pass rate</span>
  <span class="kpi"><b>${s ? s.total : doc.run.caseCount}</b>cases</span>
  <span class="kpi"><b>${s ? s.passed : '—'}</b>passed</span>
  <span class="kpi"><b>${s ? s.failed : '—'}</b>failed</span>
  <span class="kpi"><b>${s ? s.broken : '—'}</b>broken</span>
  <span class="kpi"><b>${s ? fmtMs(s.durationMs) : '—'}</b>duration</span>
</div>
<p class="muted">Created ${esc(doc.run.createdAt)} by ${esc(doc.run.createdBy || 'unknown')}.</p>
<h2>Compliance posture</h2>
${rows ? `<table><thead><tr><th>Standard</th><th>Grade</th><th>Score</th><th>Controls</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">No compliance packs evaluated.</p>'}
<h2>Sign-off & approval</h2>
<p>Sign-off status: <span class="badge">${esc(doc.signoff.status || 'none')}</span> (${doc.signoff.count} review${doc.signoff.count === 1 ? '' : 's'})
${doc.signoff.latest ? `<br><span class="muted">Latest: ${esc(doc.signoff.latest.decision)} by ${esc(doc.signoff.latest.reviewer || 'unknown')} — ${esc(doc.signoff.latest.note || '')}</span>` : ''}</p>
<p>Approval gate: <span class="badge">${esc(doc.approval.status)}</span>${doc.approval.workflowName ? ` · ${esc(doc.approval.workflowName)} (stage ${(doc.approval.stage ?? 0) + (doc.approval.status === 'approved' ? 0 : 1)}/${doc.approval.totalStages ?? 0})` : ''}</p>
<h2>Failing cases (${doc.failures.length})</h2>
${fails}
<p class="muted" style="margin-top:32px">Generated by IntelliQE API Automation · evidence document for audit retention.</p>
</body></html>`;
}

/** Real PDF via pdf-lib. Variable-specifier import keeps tsc green with or without the dep. */
export async function renderEvidencePdf(doc: EvidenceDoc): Promise<Buffer> {
  const spec = 'pdf-lib';
  const mod: any = await import(spec); // throws if not installed → caller falls back to HTML
  const { PDFDocument, StandardFonts, rgb } = mod;
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const A4: [number, number] = [595.28, 841.89];
  const margin = 48;
  const ink = rgb(0.12, 0.16, 0.22);
  const grey = rgb(0.4, 0.45, 0.52);
  const red = rgb(0.86, 0.15, 0.15);

  let page = pdf.addPage(A4);
  let y = A4[1] - margin;

  const ensure = (need: number) => { if (y - need < margin) { page = pdf.addPage(A4); y = A4[1] - margin; } };
  const wrap = (text: string, f: any, size: number, maxW: number): string[] => {
    const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
    const lines: string[] = []; let line = '';
    for (const w of words) {
      const t = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(t, size) > maxW && line) { lines.push(line); line = w; } else line = t;
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  };
  const write = (text: string, opts: { size?: number; f?: any; color?: any; gap?: number } = {}) => {
    const size = opts.size ?? 10; const f = opts.f ?? font; const color = opts.color ?? ink;
    for (const ln of wrap(text, f, size, A4[0] - margin * 2)) {
      ensure(size + 4);
      page.drawText(ln, { x: margin, y: y - size, size, font: f, color });
      y -= size + 4;
    }
    if (opts.gap) y -= opts.gap;
  };
  const rule = () => { ensure(10); page.drawLine({ start: { x: margin, y: y - 2 }, end: { x: A4[0] - margin, y: y - 2 }, thickness: 0.5, color: rgb(0.85, 0.88, 0.92) }); y -= 10; };

  write('Compliance Evidence', { size: 20, f: bold });
  write(`${doc.run.title} · run ${doc.run.runId}`, { size: 10, color: grey });
  write(`Generated ${doc.generatedAt}`, { size: 9, color: grey, gap: 6 });
  rule();

  const s = doc.run.stats;
  write('Run summary', { size: 13, f: bold, gap: 2 });
  write(s
    ? `Pass rate ${s.passRate}%  ·  ${s.total} cases  ·  ${s.passed} passed  ·  ${s.failed} failed  ·  ${s.broken} broken  ·  ${fmtMs(s.durationMs)}`
    : `${doc.run.caseCount} cases — no execution report found.`, { size: 10 });
  write(`Created ${doc.run.createdAt} by ${doc.run.createdBy || 'unknown'}`, { size: 9, color: grey, gap: 8 });

  write('Compliance posture', { size: 13, f: bold, gap: 2 });
  if (doc.compliance.length) {
    for (const c of doc.compliance) {
      write(`${c.label}: grade ${c.grade} (${c.score}%) — ${c.summary.pass || 0} pass / ${c.summary.warn || 0} warn / ${c.summary.fail || 0} fail / ${c.summary.review || 0} review`, { size: 10 });
    }
  } else write('No compliance packs evaluated.', { size: 10, color: grey });
  y -= 8;

  write('Sign-off & approval', { size: 13, f: bold, gap: 2 });
  write(`Sign-off: ${doc.signoff.status || 'none'} (${doc.signoff.count} review${doc.signoff.count === 1 ? '' : 's'})`, { size: 10 });
  if (doc.signoff.latest) write(`Latest: ${doc.signoff.latest.decision} by ${doc.signoff.latest.reviewer || 'unknown'} — ${doc.signoff.latest.note || ''}`, { size: 9, color: grey });
  write(`Approval gate: ${doc.approval.status}${doc.approval.workflowName ? ` · ${doc.approval.workflowName} (${doc.approval.totalStages ?? 0} stage${doc.approval.totalStages === 1 ? '' : 's'})` : ''}`, { size: 10, gap: 8 });

  write(`Failing cases (${doc.failures.length})`, { size: 13, f: bold, gap: 2 });
  if (doc.failures.length) {
    for (const fcase of doc.failures) {
      write(`• ${fcase.id}  ${fcase.title}`, { size: 10 });
      if (fcase.error) write(fcase.error, { size: 9, color: red });
    }
  } else write('No failing cases.', { size: 10, color: rgb(0.08, 0.5, 0.24) });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}
