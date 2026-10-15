import { createRequire } from 'module';
import { CATS, F } from './deck_data.mjs';
const require = createRequire(import.meta.url);
const pptxgen = require('pptxgenjs');

if (F.length !== 88) throw new Error(`expected 88 features, got ${F.length}`);

const DARK = '1E1B4B', INK = '0F172A', SLATE = '334155', MUT = '64748B', FAINT = '94A3B8';
const CARD = 'F8FAFC', CHIP = 'F1F5F9', LINE = 'E2E8F0', GREEN = '16A34A', GREENBG = 'DCFCE7';
const HEAD = 'Georgia', BODY = 'Calibri', MONO = 'Courier New';

const p = new pptxgen();
p.layout = 'LAYOUT_WIDE';            // 13.33 x 7.5
p.author = 'IntelliQE';
p.title = 'IntelliQE API Automation — Feature Testing Guide';
const W = 13.33, H = 7.5;

let n = 0;
const footer = (s, dark) => {
  n++;
  s.addText([{ text: 'IntelliQE', options: { bold: true } }, { text: '  ·  API Automation — feature testing guide', options: {} }],
    { x: 0.5, y: 7.07, w: 9, h: 0.3, fontFace: BODY, fontSize: 9, color: dark ? FAINT : FAINT, align: 'left', margin: 0, isTextBox: true });
  s.addText(String(n), { x: 12.0, y: 7.07, w: 0.83, h: 0.3, fontFace: BODY, fontSize: 9, color: FAINT, align: 'right', margin: 0, isTextBox: true });
};
const chip = (s, x, y, w, h, fill, text, color, size, bold) =>
  s.addText(text, { x, y, w, h, fill: { color: fill }, color, fontFace: BODY, fontSize: size, bold: !!bold, align: 'center', valign: 'middle', rectRadius: 0.08, shape: p.ShapeType.roundRect, isTextBox: true, margin: 2 });

/* ── Title slide ── */
(() => {
  const s = p.addSlide();
  s.background = { color: DARK };
  // category dots motif (top-right)
  CATS.forEach((c, i) => s.addShape(p.ShapeType.ellipse, { x: 11.2 + (i % 4) * 0.5, y: 0.6 + Math.floor(i / 4) * 0.5, w: 0.32, h: 0.32, fill: { color: c.color } }));
  s.addText('IntelliQE · API Automation', { x: 0.7, y: 1.6, w: 11, h: 0.5, fontFace: BODY, fontSize: 16, color: 'A5B4FC', charSpacing: 2, isTextBox: true });
  s.addText('88 Testing Tools', { x: 0.7, y: 2.1, w: 12, h: 1.1, fontFace: HEAD, fontSize: 54, bold: true, color: 'FFFFFF', isTextBox: true });
  s.addText('How to test every feature — description, steps & flow', { x: 0.7, y: 3.25, w: 12, h: 0.6, fontFace: HEAD, fontSize: 24, italic: true, color: 'CBD5E1', isTextBox: true });
  // stat callouts
  const stats = [['88', 'features'], ['8', 'capability groups'], ['13', 'verified live']];
  stats.forEach(([num, lab], i) => {
    const x = 0.7 + i * 3.0;
    s.addText(num, { x, y: 4.5, w: 2.6, h: 0.9, fontFace: HEAD, fontSize: 48, bold: true, color: '818CF8', align: 'left', isTextBox: true });
    s.addText(lab, { x, y: 5.4, w: 2.6, h: 0.4, fontFace: BODY, fontSize: 14, color: 'CBD5E1', align: 'left', isTextBox: true });
  });
  s.addText('2026-10-14', { x: 0.7, y: 6.6, w: 6, h: 0.4, fontFace: BODY, fontSize: 13, color: FAINT, isTextBox: true });
  s.addNotes('Overview of all 88 API-automation tools, grouped into 8 capability areas. 13 were smoke-tested live on 2026-10-14.');
})();

/* ── Overview slide ── */
(() => {
  const s = p.addSlide();
  s.background = { color: 'FFFFFF' };
  s.addText('The 8 capability groups', { x: 0.5, y: 0.45, w: 12.3, h: 0.7, fontFace: HEAD, fontSize: 34, bold: true, color: DARK, isTextBox: true });
  const counts = CATS.map((_, i) => F.filter(f => f.c === i).length);
  const cw = (12.33 - 3 * 0.3) / 4, ch = 2.35;
  CATS.forEach((c, i) => {
    const col = i % 4, row = Math.floor(i / 4);
    const x = 0.5 + col * (cw + 0.3), y = 1.55 + row * (ch + 0.35);
    s.addShape(p.ShapeType.roundRect, { x, y, w: cw, h: ch, fill: { color: CARD }, line: { color: LINE, width: 1 }, rectRadius: 0.1, shadow: { type: 'outer', color: 'C7CBD1', blur: 6, offset: 2, angle: 90, opacity: 0.4 } });
    s.addShape(p.ShapeType.ellipse, { x: x + 0.25, y: y + 0.25, w: 0.8, h: 0.8, fill: { color: c.color } });
    s.addText(String(counts[i]), { x: x + 0.25, y: y + 0.25, w: 0.8, h: 0.8, fontFace: HEAD, fontSize: 26, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', isTextBox: true });
    s.addText(c.name, { x: x + 0.2, y: y + 1.15, w: cw - 0.4, h: 0.6, fontFace: BODY, fontSize: 15, bold: true, color: INK, align: 'left', valign: 'top', isTextBox: true });
    s.addText(c.blurb, { x: x + 0.2, y: y + 1.6, w: cw - 0.4, h: 0.65, fontFace: BODY, fontSize: 10.5, color: MUT, align: 'left', valign: 'top', isTextBox: true });
  });
  footer(s, false);
  s.addNotes('Agenda: each group is a section divider followed by one slide per tool.');
})();

/* ── Per category: divider + feature slides ── */
CATS.forEach((cat, ci) => {
  const feats = F.filter(f => f.c === ci);
  // divider
  const d = p.addSlide();
  d.background = { color: cat.color };
  d.addText(`0${ci + 1}`.slice(-2), { x: 0.7, y: 0.7, w: 3, h: 1.6, fontFace: HEAD, fontSize: 120, bold: true, color: 'FFFFFF', transparency: 78, isTextBox: true });
  d.addText(cat.name, { x: 0.7, y: 2.9, w: 11.9, h: 1.1, fontFace: HEAD, fontSize: 44, bold: true, color: 'FFFFFF', isTextBox: true });
  d.addText(cat.blurb, { x: 0.72, y: 4.0, w: 10.5, h: 0.8, fontFace: HEAD, fontSize: 20, italic: true, color: 'FFFFFF', isTextBox: true });
  d.addText(`${feats.length} tools`, { x: 0.72, y: 4.9, w: 6, h: 0.5, fontFace: BODY, fontSize: 16, bold: true, color: 'FFFFFF', transparency: 15, isTextBox: true });
  footer(d, true);
  d.addNotes(`${cat.name}: ${feats.length} tools.`);

  // feature slides
  feats.forEach((f) => {
    const s = p.addSlide();
    s.background = { color: 'FFFFFF' };
    // category chip
    chip(s, 0.5, 0.45, Math.min(0.42 + cat.name.length * 0.105, 4.2), 0.34, cat.color, cat.name, 'FFFFFF', 11, true);
    // verified pill
    if (f.tested) chip(s, 10.9, 0.45, 1.93, 0.34, GREENBG, '✓ Verified live', GREEN, 11, true);
    // title
    s.addText(f.t, { x: 0.5, y: 0.92, w: 12.3, h: 0.8, fontFace: HEAD, fontSize: 30, bold: true, color: DARK, valign: 'top', isTextBox: true });
    // description
    s.addText(f.d, { x: 0.5, y: 1.72, w: 7.35, h: 0.95, fontFace: BODY, fontSize: 15, color: SLATE, valign: 'top', isTextBox: true });
    // how to test
    s.addText('HOW TO TEST', { x: 0.5, y: 2.72, w: 7.35, h: 0.3, fontFace: BODY, fontSize: 13, bold: true, color: cat.color, charSpacing: 1, isTextBox: true });
    s.addText(f.where, { x: 0.5, y: 3.03, w: 7.35, h: 0.3, fontFace: BODY, fontSize: 12, italic: true, color: MUT, isTextBox: true });
    s.addText(f.s.map((st, i) => ({ text: st, options: { bullet: { type: 'number' }, breakLine: true, paraSpaceAfter: 7 } })),
      { x: 0.55, y: 3.42, w: 7.3, h: 2.1, fontFace: BODY, fontSize: 14, color: INK, valign: 'top', isTextBox: true });
    // API chip
    s.addShape(p.ShapeType.roundRect, { x: 0.5, y: 5.75, w: 7.35, h: 0.62, fill: { color: CHIP }, line: { color: LINE, width: 1 }, rectRadius: 0.06 });
    s.addText([{ text: 'API  ', options: { bold: true, color: cat.color, fontFace: BODY } }, { text: f.api, options: { fontFace: MONO, color: INK } }],
      { x: 0.7, y: 5.75, w: 6.95, h: 0.62, fontSize: 11.5, align: 'left', valign: 'middle', isTextBox: true, margin: 2 });

    // ── flow diagram (right column) ──
    s.addText('TEST FLOW', { x: 8.25, y: 1.72, w: 4.4, h: 0.3, fontFace: BODY, fontSize: 13, bold: true, color: MUT, charSpacing: 1, isTextBox: true });
    const nodes = f.flow;
    const nx = 8.35, nw = 4.4, nh = 1.05, ys = [2.1, 3.45, 4.8];
    nodes.forEach((label, i) => {
      const y = ys[i];
      const mid = i === 1;
      s.addShape(p.ShapeType.roundRect, { x: nx, y, w: nw, h: nh, fill: { color: mid ? cat.color : CARD }, line: { color: cat.color, width: mid ? 0 : 1.5 }, rectRadius: 0.09, shadow: mid ? { type: 'outer', color: 'B9BEC4', blur: 7, offset: 2, angle: 90, opacity: 0.45 } : undefined });
      s.addText([{ text: (i === 0 ? 'INPUT' : i === 1 ? 'INTELLIQE' : 'RESULT'), options: { fontSize: 9, bold: true, color: mid ? 'FFFFFF' : cat.color, breakLine: true, charSpacing: 1 } },
                 { text: label, options: { fontSize: 15, bold: true, color: mid ? 'FFFFFF' : INK } }],
        { x: nx + 0.15, y, w: nw - 0.3, h: nh, align: 'center', valign: 'middle', fontFace: BODY, isTextBox: true, margin: 2 });
      if (i < 2) s.addShape(p.ShapeType.line, { x: nx + nw / 2, y: y + nh, w: 0, h: ys[i + 1] - (y + nh), line: { color: cat.color, width: 2, endArrowType: 'triangle' } });
    });
    footer(s, false);
    s.addNotes(`${f.t} — ${f.d}\nHeadless: ${f.api}${f.tested ? '\n[Verified live 2026-10-14]' : ''}`);
  });
});

await p.writeFile({ fileName: 'IntelliQE_API_Automation_88_Features.pptx' });
console.log(`wrote deck with ${n} footer slides (+ title) — total ${n + 1} slides`);
