import { remediate } from '../src/services/ada/ada-remediation.js';
const cases = [
  { pageUrl: 'https://jade-biz.com/contact/', category: 'accessibility', ruleId: 'select-name', severity: 'critical', title: 'Select element must have an accessible name', occurrences: 1, element: 'select[name="time_slot"]', htmlSnippet: '<select name="time_slot" class="form-control"><option>Morning</option></select>', details: { failureSummary: 'Fix any of the following:\n  Form element does not have an implicit (wrapped) <label>' } },
  { pageUrl: 'https://x.com/', category: 'accessibility', ruleId: 'color-contrast', severity: 'serious', title: 'Elements must meet minimum color contrast ratio thresholds', occurrences: 1, element: '.hero p', htmlSnippet: '<p class="lead">Powering communities</p>', details: { failureSummary: 'Fix any of the following:\n  Element has insufficient color contrast of 2.85 (foreground color: #8a8a8a, background color: #ffffff, font size: 12.0pt (16px), font weight: normal). Expected contrast ratio of 4.5:1' } },
  { pageUrl: 'https://x.com/', category: 'accessibility', ruleId: 'image-alt', severity: 'critical', title: 'Images must have alternative text', occurrences: 1, element: 'img.hero', htmlSnippet: '<img src="/assets/wind-turbines-hero.jpg" class="hero">', details: {} },
  { pageUrl: 'https://x.com/', category: 'links', ruleId: 'http-404', severity: 'serious', title: 'Broken link (HTTP 404)', occurrences: 3, element: 'https://tracker.x.com/map', details: { link: 'https://tracker.x.com/map', status: 404, linkText: 'Report outage', referrers: ['https://x.com/', 'https://x.com/a', 'https://x.com/b'] } },
  { pageUrl: 'https://x.com/', category: 'best-practice', ruleId: 'link-noopener', severity: 'moderate', title: 'New-tab links use rel="noopener"', occurrences: 4, htmlSnippet: '<a href="https://ext.com" target="_blank">Partner</a>', details: {} },
  { pageUrl: 'https://x.com/', category: 'best-practice', ruleId: 'axe-landmark-unique', severity: 'moderate', title: 'Landmarks should have a unique role', occurrences: 2, htmlSnippet: '<nav class="footer-nav">', details: {} },
  { pageUrl: 'https://x.com/', category: 'review', ruleId: 'color-contrast', severity: 'serious', title: 'Elements must meet minimum color contrast', occurrences: 1, htmlSnippet: '<span>Over image</span>', details: { failureSummary: 'Fix any of the following:\n  Element\'s background color could not be determined due to a background image' } },
  { pageUrl: 'https://x.com/', category: 'accessibility', ruleId: 'some-unknown-rule', severity: 'minor', title: 'Unknown rule', occurrences: 1, htmlSnippet: '<div>x</div>', details: { failureSummary: 'Fix all of the following:\n  Do the first thing\n  Do the second thing' } },
] as const;
for (const c of cases) {
  const r = remediate(c as never);
  console.log(`\n=== ${c.category}/${c.ruleId} [${r.effort}] ===`);
  console.log('PROBLEM:', r.problem);
  r.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  if (r.example) { console.log('  BEFORE:', r.example.before); console.log('  AFTER :', r.example.after); if (r.example.note) console.log('  NOTE  :', r.example.note); }
}
