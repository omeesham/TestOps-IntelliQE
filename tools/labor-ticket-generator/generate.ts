/**
 * Synthetic labor ticket generator for document-scanning tests.
 *
 * Writes scan-like, image-only labor ticket PDFs plus answer-key.json. This
 * script chooses every value, so the answer key is correct by construction and
 * nobody has to label real tickets. All names and numbers are invented.
 *
 * Layout: a ticket printed from the order system (typed header), filled in by
 * hand (worker rows) and signed. Expected values follow literal reading:
 *   - ditto marks, "same as above" and struck-out rows are expected EMPTY;
 *   - a crossed-out and rewritten value expects the rewritten value;
 *   - billing pen marks and totals lines are noise and are not expected anywhere;
 *   - only hours are checked against each other, never time arithmetic.
 *
 *   cd backend && npx tsx ../tools/labor-ticket-generator/generate.ts \
 *     [--count 20] [--seed 42] [--out <dir>] [--mix clean:4,average:3,messy:2,poor:1]
 *
 * Needs the backend's Playwright browser and network access to Google Fonts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const requireFromBackend = createRequire(path.join(here, '../../backend/package.json'));
const { chromium } = requireFromBackend('@playwright/test') as typeof import('@playwright/test');

// ── CLI ──────────────────────────────────────────────────────────────
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const COUNT = Number(arg('count', '20'));
const SEED = Number(arg('seed', '42'));
const OUT = path.resolve(arg('out', path.join(here, 'output')));
const MIX = arg('mix', 'clean:4,average:3,messy:2,poor:1').split(',').map((s) => {
  const [quality, weight] = s.split(':');
  return [quality as Quality, Number(weight)] as const;
});

// ── Types ────────────────────────────────────────────────────────────
type Quality = 'clean' | 'average' | 'messy' | 'poor';

/** Field names exactly as the scanning screen labels them. */
const HEADER_FIELDS = ['Ticket Number', 'Show Name', 'Project', 'Booth Number', 'Customer Name', 'Order / Line', 'Item', 'Start Date', 'Order Received Date'] as const;
const ROW_FIELDS = ['Worker Name', 'Date', 'Start Time', 'Stop Time', 'ST Hrs', 'OT Hrs', 'DT Hrs'] as const;
type HeaderField = typeof HEADER_FIELDS[number];
type RowField = typeof ROW_FIELDS[number];

/** Why a cell is expected empty although something is written there. */
type EmptyReason = 'ditto mark' | 'same as above' | 'struck-out row';

interface WorkerRow {
  /** What is written on the ticket (shown handwritten). */
  written: Record<RowField, string>;
  /** What the scan must produce: '' where literal reading leaves the field empty. */
  expected: Record<RowField, string>;
  emptyBecause: Partial<Record<RowField, EmptyReason>>;
  /** Value crossed out before the correct one was written next to it. */
  corrections: Partial<Record<RowField, string>>;
  struck: boolean;
}

interface Ticket {
  fileName: string;
  quality: Quality;
  header: Record<HeaderField, string>;
  rows: WorkerRow[];
  /** Marks on the ticket that are not data and must be ignored by the scan. */
  noise: string[];
}

interface QualityProfile { fonts: string[]; wordTilt: number; pageTilt: number; blur: number; noise: number; fade: number; correctionP: number; quirkP: number }

// ── Seeded randomness (same seed → same tickets) ─────────────────────
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const between = (lo: number, hi: number): number => lo + rand() * (hi - lo);
const int = (lo: number, hi: number): number => Math.floor(between(lo, hi + 1));
const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
const chance = (p: number): boolean => rand() < p;
const pad2 = (n: number): string => String(n).padStart(2, '0');

// ── Reference data (all invented) ────────────────────────────────────
const FIRST = ['Maria', 'James', 'Luis', 'Ana', 'Robert', 'Keisha', 'Tom', 'Priya', 'Carlos', 'Dana', 'Marcus', 'Elena', 'Sam', 'Grace', 'Victor'];
const LAST = ['Alvarez', 'Brooks', 'Chen', 'Dalton', 'Evans', 'Fischer', 'Garcia', 'Hughes', 'Ibarra', 'Jensen', 'Kowalski', 'Lopez', 'Moreno', 'Nolan', 'Ortiz'];
const CUSTOMERS = ['Acme Exhibits LLC', 'Northstar Displays', 'Bluewave Events Inc', 'Summit Booth Co', 'Redline Marketing', 'Harbor Expo Group'];
const ITEMS = ['Installation Labor - ST', 'Dismantle Labor - ST', 'Installation Labor - OT', 'Booth Supervision Labor'];
const SHOW = 'GES TEST SHOW - TRADESHOW - DO NOT USE';
const BILLING_MARKS = ['STT Line 2.1 AK', 'chk JB', 'bill L3', 'OK - RM'];

const FONTS = {
  neat: ['Caveat', 'Patrick Hand', 'Kalam'],
  normal: ['Indie Flower', 'Shadows Into Light', 'Nanum Pen Script', 'Gochi Hand'],
  hard: ['Reenie Beanie', 'Homemade Apple', 'Rock Salt', 'Zeyada'],
};
const ALL_FONTS = [...FONTS.neat, ...FONTS.normal, ...FONTS.hard];
const INKS = ['#1b2a6b', '#0d1b4c', '#202020', '#1f3f8f'];

/** Modest effects: the ticket must stay readable to a person; the point is to stress the scan. */
const QUALITY: Record<Quality, QualityProfile> = {
  clean: { fonts: FONTS.neat, wordTilt: 1, pageTilt: 0, blur: 0, noise: 0, fade: 1, correctionP: 0, quirkP: 0.15 },
  average: { fonts: [...FONTS.neat, ...FONTS.normal], wordTilt: 2.5, pageTilt: 0.6, blur: 0.25, noise: 0.05, fade: 0.95, correctionP: 0.12, quirkP: 0.3 },
  messy: { fonts: [...FONTS.normal, ...FONTS.hard], wordTilt: 4, pageTilt: 1.2, blur: 0.5, noise: 0.1, fade: 0.85, correctionP: 0.3, quirkP: 0.45 },
  poor: { fonts: FONTS.hard, wordTilt: 5, pageTilt: 2, blur: 0.9, noise: 0.18, fade: 0.7, correctionP: 0.3, quirkP: 0.45 },
};

// ── Ticket data ──────────────────────────────────────────────────────
const usDate = (iso: string): string => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };

/** A handwritten time the way people write it; the key keeps 24-hour "HH:MM". */
function writtenTime(h: number, m: number): string {
  const h12 = h % 12 || 12;
  const ap = h < 12 ? 'AM' : 'PM';
  return pick([`${h12}:${pad2(m)} ${ap}`, `${h12}:${pad2(m)}${ap[0].toLowerCase()}`, `${pad2(h)}:${pad2(m)}`]);
}

const hours = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function makeTicket(index: number, quality: Quality): Ticket {
  const q = QUALITY[quality];
  // Days ≤ 12 make US month/day easy to swap with day/month, so they come often.
  const month = int(1, 12);
  const day = chance(0.6) ? int(1, 12) : int(13, 28);
  const startIso = `2026-${pad2(month)}-${pad2(day)}`;
  const header: Record<HeaderField, string> = {
    'Ticket Number': String(int(10_000_000, 99_999_999)),
    'Show Name': SHOW,
    Project: String(int(10_000_000, 99_999_999)).padStart(9, '0'),
    'Booth Number': `${pick(['A', 'B', 'C', 'D'])}${int(100, 2999)}`,
    'Customer Name': pick(CUSTOMERS),
    'Order / Line': `${int(1_000_000, 9_999_999)} / ${int(1, 9)}`,
    Item: pick(ITEMS),
    'Start Date': startIso,
    'Order Received Date': `2026-${pad2(Math.max(1, month - 1))}-${pad2(int(1, 28))}`,
  };

  const rows: WorkerRow[] = [];
  const rowCount = quality === 'clean' ? int(1, 3) : int(2, 5);
  for (let r = 0; r < rowCount; r++) {
    const startH = int(6, 9);
    const startM = pick([0, 0, 15, 30]);
    const st = pick([4, 6, 7.5, 8, 8]);
    const ot = pick([0, 0, 0, 1, 2, 2.5]);
    const dt = pick([0, 0, 0, 0, 1]);
    const stopH = startH + Math.floor(st + ot + dt) + 1;
    const stopM = startM;
    const dateIso = r > 0 && chance(0.5) ? startIso : `2026-${pad2(month)}-${pad2(Math.min(28, day + int(0, 2)))}`;
    const values: Record<RowField, string> = {
      'Worker Name': `${pick(FIRST)} ${pick(LAST)}`,
      Date: dateIso,
      'Start Time': `${pad2(startH)}:${pad2(startM)}`,
      'Stop Time': `${pad2(Math.min(stopH, 23))}:${pad2(stopM)}`,
      'ST Hrs': hours(st),
      'OT Hrs': hours(ot),
      'DT Hrs': hours(dt),
    };
    const written: Record<RowField, string> = {
      ...values,
      Date: usDate(values.Date),
      'Start Time': writtenTime(startH, startM),
      'Stop Time': writtenTime(Math.min(stopH, 23), stopM),
      // Zero hours are often left blank on paper; the screen shows 0.
      'OT Hrs': ot === 0 && chance(0.5) ? '' : values['OT Hrs'],
      'DT Hrs': dt === 0 && chance(0.6) ? '' : values['DT Hrs'],
    };
    const row: WorkerRow = { written, expected: { ...values }, emptyBecause: {}, corrections: {}, struck: false };

    // Literal-reading quirks, only after the first row (they refer to the row above).
    if (r > 0 && chance(q.quirkP)) {
      const quirk = pick(['ditto-date', 'ditto-date', 'same-as-above', 'struck'] as const);
      if (quirk === 'ditto-date') {
        row.written.Date = '"';
        row.expected.Date = '';
        row.emptyBecause.Date = 'ditto mark';
      } else if (quirk === 'same-as-above') {
        row.written['Worker Name'] = 'same as above';
        row.expected['Worker Name'] = '';
        row.emptyBecause['Worker Name'] = 'same as above';
      } else {
        row.struck = true;
        for (const f of ROW_FIELDS) { row.expected[f] = ''; row.emptyBecause[f] = 'struck-out row'; }
      }
    }
    // A wrong value crossed out, the right one written beside it (key = the right one).
    if (!row.struck && chance(q.correctionP)) {
      const field = pick(['ST Hrs', 'Start Time', 'Worker Name'] as const);
      if (row.expected[field]) row.corrections[field] = field === 'ST Hrs' ? hours(Math.max(0, Number(values['ST Hrs']) - 1)) : field === 'Start Time' ? writtenTime(Math.max(5, startH - 1), startM) : pick(LAST);
    }
    rows.push(row);
  }

  const noise = [`billing mark "${pick(BILLING_MARKS)}"`];
  if (chance(0.5)) noise.push('circled line number');
  if (rows.length > 1) noise.push('handwritten "Total" row under the worker rows');
  return { fileName: `LT-${String(index).padStart(4, '0')}-${quality}.pdf`, quality, header, rows, noise };
}

// ── Rendering ────────────────────────────────────────────────────────
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

interface Pen { font: string; ink: string; size: number }

function hw(text: string, q: QualityProfile, pen: Pen, crossedOut?: string): string {
  if (!text) return '';
  const css = [
    `font-family:'${pen.font}'`, `font-size:${(pen.size * between(0.92, 1.1)).toFixed(1)}px`, `color:${pen.ink}`,
    `transform:rotate(${between(-q.wordTilt, q.wordTilt).toFixed(2)}deg) translateY(${between(-3, 3).toFixed(1)}px)`,
    `letter-spacing:${between(-0.3, 1.2).toFixed(2)}px`, `opacity:${q.fade}`,
  ].join(';');
  const struck = crossedOut ? `<span class="crossed">${esc(crossedOut)}</span> ` : '';
  return `<span class="hw" style="${css}">${struck}${esc(text)}</span>`;
}

function ticketHtml(t: Ticket): { html: string; font: string; challenges: string[] } {
  const q = QUALITY[t.quality];
  const pen: Pen = { font: pick(q.fonts), ink: pick(INKS), size: t.quality === 'poor' ? 25 : 27 };
  const challenges: string[] = [];
  if (FONTS.hard.includes(pen.font)) challenges.push(`hard-to-read handwriting (${pen.font})`);
  const swappable = t.rows.some((r) => !r.struck && r.expected.Date && Number(r.expected.Date.slice(8)) <= 12);
  if (swappable) challenges.push('US dates with day ≤ 12 (day/month swap risk)');
  for (const r of t.rows) {
    for (const reason of new Set(Object.values(r.emptyBecause))) challenges.push(reason as string);
    if (Object.keys(r.corrections).length) challenges.push('crossed-out and rewritten value');
  }

  const head = HEADER_FIELDS.map((f) => `<div class="cell"><div class="lbl">${esc(f)}</div><div class="typed">${esc(f.endsWith('Date') ? usDate(t.header[f]) : t.header[f])}</div></div>`).join('');
  const body = t.rows.map((r) => {
    // A ditto mark is written large and centred, as people do.
    const cells = ROW_FIELDS.map((f) => (r.written[f] === '"' ? `<td style="text-align:center">${hw('"', q, { ...pen, size: pen.size * 1.8 })}</td>` : `<td>${hw(r.written[f], q, pen, r.corrections[f])}</td>`)).join('');
    return `<tr class="${r.struck ? 'struck-row' : ''}">${cells}</tr>`;
  }).join('');
  const counted = t.rows.filter((r) => !r.struck);
  const total = t.noise.some((n) => n.includes('"Total" row'))
    ? `<tr><td>${hw('Total', q, pen)}</td><td></td><td></td><td></td><td>${hw(hours(counted.reduce((s, r) => s + Number(r.expected['ST Hrs']), 0)), q, pen)}</td><td></td><td></td></tr>` : '';
  const blanks = '<tr>' + '<td></td>'.repeat(7) + '</tr>';
  // Marks go in the margins, never over a value, so a person can still read every expected value.
  const billing = `<div class="note" style="left:${int(760, 960)}px;top:${int(55, 95)}px;color:#b3261e;font-family:'Gochi Hand';font-size:24px;transform:rotate(-8deg)">${esc(t.noise[0].match(/"(.*)"/)?.[1] || '')}</div>`;
  const circle = t.noise.includes('circled line number')
    ? `<div class="note circle" style="left:${int(12, 20)}px;top:${int(440, 600)}px">${int(1, 6)}</div>` : '';

  const html = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?${ALL_FONTS.map((n) => `family=${n.replace(/ /g, '+')}`).join('&')}&display=block" rel="stylesheet">
<style>
  body { margin:0; background:#fff; }
  #scan { width:1240px; height:1754px; position:relative; overflow:hidden; background:#fbfaf6;
          transform:rotate(${between(-q.pageTilt, q.pageTilt).toFixed(2)}deg); filter:blur(${q.blur}px) contrast(${(1 - q.noise / 2).toFixed(2)});
          font-family:Arial,Helvetica,sans-serif; color:#222; }
  .form { position:absolute; inset:60px 70px; }
  .title { font-size:40px; font-weight:bold; letter-spacing:4px; }
  .sub { font-size:18px; color:#555; margin-bottom:24px; }
  .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:12px 24px; border:2px solid #333; padding:16px; }
  .lbl { font-size:14px; text-transform:uppercase; color:#555; }
  .typed { font-family:'Courier New',monospace; font-size:21px; padding-top:4px; }
  table { width:100%; border-collapse:collapse; margin-top:28px; }
  th { font-size:15px; text-transform:uppercase; color:#444; border:1.5px solid #333; padding:8px 6px; background:#eee; }
  td { border:1.5px solid #333; height:44px; padding:2px 8px; vertical-align:middle; }
  .hw { display:inline-block; white-space:nowrap; }
  .crossed { text-decoration:line-through; text-decoration-thickness:2px; }
  .struck-row td { background:linear-gradient(to bottom right, transparent 47%, #1b2a6b 48%, #1b2a6b 50%, transparent 51%); }
  .note { position:absolute; }
  .circle { border:2.5px solid #b3261e; border-radius:50%; width:40px; height:40px; text-align:center; line-height:40px; color:#b3261e; font-family:'Gochi Hand'; font-size:24px; }
  .sign { position:absolute; left:0; bottom:120px; font-size:16px; }
  .noise { position:absolute; inset:0; opacity:${q.noise}; background-image:radial-gradient(#000 0.6px, transparent 0.7px); background-size:5px 5px; mix-blend-mode:multiply; }
</style></head><body><div id="scan"><div class="form">
  <div class="title">LABOR TICKET</div>
  <div class="sub">Printed from the order system. Fill in worker hours by hand.</div>
  <div class="grid">${head}</div>
  <table><tr>${ROW_FIELDS.map((f) => `<th>${esc(f)}</th>`).join('')}</tr>${body}${total}${blanks.repeat(Math.max(1, 6 - t.rows.length))}</table>
  <div class="sign">Supervisor signature: ${hw('J. Smith', q, pen)} &nbsp;&nbsp; Date: ${hw(usDate(t.header['Start Date']), q, pen)}</div>
</div>${billing}${circle}<div class="noise"></div></div></body></html>`;
  return { html, font: pen.font, challenges: [...new Set(challenges)] };
}

// ── Main ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const total = MIX.reduce((s, [, w]) => s + w, 0);
  // The batch follows the mix exactly, with each quality spread evenly through it.
  const plan = MIX.flatMap(([quality, weight]) => {
    const n = Math.round((COUNT * weight) / total);
    return Array.from({ length: n }, (_, k) => ({ quality, at: (k + 0.5) / n }));
  }).sort((a, b) => a.at - b.at).map((p) => p.quality);
  const qualityFor = (i: number): Quality => plan[i - 1] ?? MIX[0][0];

  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  const page = await browser.newPage({ viewport: { width: 1240, height: 1754 } });
  const answerKey: Record<string, unknown> = {};
  try {
    for (let i = 1; i <= COUNT; i++) {
      const ticket = makeTicket(i, qualityFor(i));
      const { html, font, challenges } = ticketHtml(ticket);
      await page.setContent(html, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      const scan = await page.locator('#scan').screenshot({ type: 'jpeg', quality: 82 });
      // An image-only PDF (no text layer), like a scanned paper ticket.
      await page.setContent(`<html><body style="margin:0"><img src="data:image/jpeg;base64,${scan.toString('base64')}" style="width:210mm;height:297mm;display:block"></body></html>`);
      await page.pdf({ path: path.join(OUT, ticket.fileName), format: 'A4', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });

      answerKey[ticket.fileName] = {
        tags: [ticket.quality, ...challenges],
        handwriting: font,
        fields: ticket.header,
        rows: ticket.rows.map((r) => ({
          expected: r.expected,
          ...(Object.keys(r.emptyBecause).length ? { emptyBecause: r.emptyBecause } : {}),
          ...(Object.keys(r.corrections).length ? { crossedOutBeforeCorrection: r.corrections } : {}),
        })),
        ignore: ticket.noise,
      };
      console.log(`${ticket.fileName}  ${ticket.quality.padEnd(7)} ${font.padEnd(18)} ${challenges.join('; ') || '-'}`);
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(OUT, 'answer-key.json'), `${JSON.stringify(answerKey, null, 2)}\n`);
  console.log(`\n${COUNT} labor tickets + answer-key.json written to ${OUT} (seed ${SEED})`);
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });
