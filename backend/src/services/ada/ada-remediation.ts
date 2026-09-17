/**
 * Remediation guidance for audit findings.
 *
 * The scanner (axe-core, the link checker, the hygiene rules) tells us WHAT is
 * wrong. This module turns each finding into something a developer can act on
 * without leaving the report:
 *   - problem : one plain sentence, specific to the element where we can be
 *   - steps   : how to fix it, in order
 *   - example : the offending HTML and a corrected version (rewritten from the
 *               real snippet when the fix is mechanical, e.g. adding alt/lang/
 *               aria-label/rel, or a lightened/darkened colour for contrast)
 *   - effort  : quick / moderate / involved, so triage can be done from the list
 *
 * Applied at scan time and again on read for findings persisted before this
 * existed, so every report - old or new - carries the same guidance.
 */
import type { Finding, Severity } from './ada-types.js';

export type Effort = 'quick' | 'moderate' | 'involved';

export interface Remediation {
  problem: string;
  steps: string[];
  example?: { before: string; after: string; note?: string };
  effort: Effort;
  /** Who this affects and why it matters - for the non-technical reader. */
  impact?: string;
}

/* ───────────────────────────── small HTML helpers ───────────────────────────── */

function tagOf(html: string): string {
  const m = /^\s*<([a-z][a-z0-9-]*)/i.exec(html || '');
  return m ? m[1].toLowerCase() : '';
}
function attr(html: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(html || '');
  return m ? (m[2] ?? m[3] ?? m[4]) : undefined;
}
function hasAttr(html: string, name: string): boolean {
  return new RegExp(`\\s${name}(\\s|=|>|/)`, 'i').test(html || '');
}
/** Insert or replace an attribute on the opening tag of the snippet. */
function setAttr(html: string, name: string, value: string): string {
  if (!html) return html;
  const re = new RegExp(`(\\s${name}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s>]+)`, 'i');
  if (re.test(html)) return html.replace(re, `$1"${value}"`);
  return html.replace(/^(\s*<[a-z][a-z0-9-]*)/i, `$1 ${name}="${value}"`);
}
function humanise(s: string): string {
  return s.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().replace(/^\w/, (c) => c.toUpperCase());
}
function trim(html: string, max = 240): string {
  const one = (html || '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}
function guessName(html: string): string {
  const n = attr(html, 'name') || attr(html, 'id') || attr(html, 'placeholder') || attr(html, 'title');
  return n ? humanise(n) : '';
}

/* ───────────────────────────── colour contrast ───────────────────────────── */

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** Nudge the foreground towards black or white (whichever helps) until the ratio is met. */
function suggestForeground(fg: string, bg: string, target: number): { hex: string; ratio: number } | null {
  const f = hexToRgb(fg), b = hexToRgb(bg);
  if (!f || !b) return null;
  const towardsDark = luminance(b) > 0.5;
  let best = { hex: fg, ratio: contrast(f, b) };
  for (let step = 1; step <= 40; step++) {
    const k = step / 40;
    const c: [number, number, number] = towardsDark
      ? [f[0] * (1 - k), f[1] * (1 - k), f[2] * (1 - k)]
      : [f[0] + (255 - f[0]) * k, f[1] + (255 - f[1]) * k, f[2] + (255 - f[2]) * k];
    const r = contrast(c, b);
    best = { hex: rgbToHex(c), ratio: r };
    if (r >= target) break;
  }
  return best.ratio >= target ? best : null;
}
function parseContrast(summary: string): { ratio?: string; fg?: string; bg?: string; expected?: string } {
  const ratio = /contrast of ([\d.]+)/i.exec(summary)?.[1];
  const fg = /foreground color:\s*(#[0-9a-f]{6})/i.exec(summary)?.[1];
  const bg = /background color:\s*(#[0-9a-f]{6})/i.exec(summary)?.[1];
  const expected = /Expected contrast ratio of ([\d.]+):1/i.exec(summary)?.[1];
  return { ratio, fg, bg, expected };
}

/* ───────────────────────────── the guidance ───────────────────────────── */

type Ctx = { html: string; element: string; page: string; summary: string; details: Record<string, unknown> };
type Rule = (c: Ctx) => Remediation;

const R: Record<string, Rule> = {
  /* ── forms & names ── */
  'select-name': ({ html }) => nameFix(html, 'select', 'This dropdown has no label, so a screen reader announces it only as "combo box" and the user cannot tell what they are choosing.'),
  'label': ({ html }) => nameFix(html, tagOf(html) || 'input', 'This form field has no label, so assistive technology cannot tell the user what to type or choose.'),
  'aria-input-field-name': ({ html }) => nameFix(html, tagOf(html) || 'input', 'This custom form control has no accessible name.'),
  'aria-toggle-field-name': ({ html }) => nameFix(html, tagOf(html) || 'input', 'This toggle has no accessible name, so its purpose is not announced.'),
  'aria-command-name': ({ html }) => nameFix(html, tagOf(html) || 'div', 'This control has a button/link/menuitem role but no accessible name.'),
  'button-name': ({ html }) => ({
    problem: 'This button has no text or label, so a screen reader announces just "button" and the user does not know what it does.',
    impact: 'Blind and low-vision users cannot tell what the button does; voice-control users cannot say its name to press it.',
    steps: ['Give the button visible text, or', 'if it is icon-only, add aria-label describing the action (e.g. "Search", "Close menu"), and', 'mark the icon decorative with aria-hidden="true".'],
    example: { before: trim(html), after: trim(setAttr(html, 'aria-label', 'Describe the action')), note: 'Replace "Describe the action" with what the button does, e.g. "Open menu".' },
    effort: 'quick',
  }),
  'link-name': ({ html }) => ({
    problem: 'This link has no discernible text (image without alt, icon only, or empty), so its destination is not announced.',
    impact: 'Screen-reader users hear "link" with no destination; voice-control users cannot activate it by name.',
    steps: ['Add visible link text, or', 'if the link wraps an image, give the image a descriptive alt (the alt becomes the link text), or', 'add aria-label with the destination (e.g. "Home", "Read the annual report").'],
    example: { before: trim(html), after: trim(setAttr(html, 'aria-label', 'Where the link goes')) },
    effort: 'quick',
  }),
  'image-alt': ({ html }) => imgAltFix(html),
  'input-image-alt': ({ html }) => ({
    problem: 'This image button has no alt text, so its purpose is not announced.',
    steps: ['Add alt describing the action the button performs.'],
    example: { before: trim(html), after: trim(setAttr(html, 'alt', 'Submit search')) },
    effort: 'quick',
  }),
  'area-alt': ({ html }) => ({
    problem: 'An image-map area has no alt text.',
    steps: ['Add alt to every <area> naming its destination.'],
    example: { before: trim(html), after: trim(setAttr(html, 'alt', 'Destination name')) },
    effort: 'quick',
  }),
  'svg-img-alt': ({ html }) => ({
    problem: 'This SVG is exposed as an image but has no accessible name.',
    steps: ['Add a <title> element inside the SVG and reference it with aria-labelledby, or add aria-label on the <svg>.', 'If the graphic is decorative, use aria-hidden="true" instead.'],
    example: { before: trim(html), after: trim(setAttr(html, 'aria-label', 'What the graphic shows')) },
    effort: 'quick',
  }),
  'role-img-alt': ({ html }) => ({
    problem: 'An element with role="img" has no accessible name.',
    steps: ['Add aria-label or aria-labelledby describing the image.'],
    example: { before: trim(html), after: trim(setAttr(html, 'aria-label', 'What the image shows')) },
    effort: 'quick',
  }),
  'object-alt': ({ html }) => ({
    problem: 'An <object> has no text alternative.',
    steps: ['Put fallback text inside the <object>, or add aria-label.'],
    example: { before: trim(html), after: trim(setAttr(html, 'aria-label', 'What the object shows')) },
    effort: 'quick',
  }),
  'label-title-only': ({ html }) => ({
    problem: 'This field is named only by a title attribute, which is not reliably announced.',
    steps: ['Add a visible <label for="…"> (preferred) or aria-label.'],
    example: { before: trim(html), after: trim(setAttr(html, 'aria-label', guessName(html) || 'Field name')) },
    effort: 'quick',
  }),
  'form-field-multiple-labels': () => ({
    problem: 'This field has more than one label, so assistive technology may announce the wrong one.',
    steps: ['Keep a single <label for="…"> per field; move extra text into aria-describedby.'],
    effort: 'quick',
  }),
  'autocomplete-valid': ({ html }) => ({
    problem: `The autocomplete value "${attr(html, 'autocomplete') || ''}" is not a valid token, so browsers and assistive tech cannot autofill the field.`,
    steps: ['Use a valid autocomplete token: name, email, tel, street-address, postal-code, cc-number, etc.', 'Remove the attribute if the field has no matching token.'],
    example: { before: trim(html), after: trim(setAttr(html, 'autocomplete', 'email')) },
    effort: 'quick',
  }),

  /* ── document ── */
  'html-has-lang': ({ html }) => ({
    problem: 'The page does not declare its language, so screen readers may read English text with the wrong voice and pronunciation.',
    impact: 'Screen readers pick a voice by page language; without it, text is mispronounced.',
    steps: ['Add lang to the <html> element with the page\'s primary language code.'],
    example: { before: trim(html) || '<html>', after: trim(setAttr(html || '<html>', 'lang', 'en')) },
    effort: 'quick',
  }),
  'html-lang-valid': ({ html }) => ({
    problem: `The page language "${attr(html, 'lang') || ''}" is not a valid language code.`,
    steps: ['Use a valid BCP 47 code, e.g. lang="en" or lang="en-US".'],
    example: { before: trim(html), after: trim(setAttr(html, 'lang', 'en')) },
    effort: 'quick',
  }),
  'valid-lang': ({ html }) => ({
    problem: `An element uses an invalid lang value "${attr(html, 'lang') || ''}".`,
    steps: ['Correct it to a valid BCP 47 code, e.g. lang="es".'],
    effort: 'quick',
  }),
  'document-title': () => ({
    problem: 'The page has no <title>, so browser tabs, bookmarks and screen readers cannot identify it.',
    steps: ['Add a unique, descriptive <title> in the <head>, e.g. "Billing & Payment | CenterPoint Energy".'],
    example: { before: '<head>\n  …\n</head>', after: '<head>\n  <title>Page name | Site name</title>\n  …\n</head>' },
    effort: 'quick',
  }),
  'meta-viewport': ({ html }) => ({
    problem: 'The viewport meta tag disables zooming, so low-vision users cannot enlarge the page.',
    steps: ['Remove user-scalable=no and any maximum-scale below 5.'],
    example: { before: trim(html), after: '<meta name="viewport" content="width=device-width, initial-scale=1">' },
    effort: 'quick',
  }),
  'meta-refresh': () => ({
    problem: 'The page refreshes or redirects itself on a timer, which disorients users and can interrupt assistive technology.',
    steps: ['Remove the meta refresh; use a server-side redirect, or let the user trigger the refresh.'],
    effort: 'quick',
  }),
  'frame-title': ({ html }) => ({
    problem: 'This iframe has no title, so screen-reader users cannot tell what it contains.',
    steps: ['Add a title attribute describing the frame\'s content, e.g. "Payment form" or "Map of service area".'],
    example: { before: trim(html), after: trim(setAttr(html, 'title', 'What the frame contains')) },
    effort: 'quick',
  }),
  'frame-focusable-content': () => ({
    problem: 'An iframe with focusable content is hidden with tabindex="-1", trapping keyboard users out of it.',
    steps: ['Remove tabindex="-1" from the <iframe>.'],
    effort: 'quick',
  }),
  'bypass': () => ({
    problem: 'There is no way to skip past the repeated header and navigation, so keyboard users must tab through every menu item on every page.',
    steps: ['Add a "Skip to main content" link as the first focusable element, pointing at the main landmark.', 'Wrap the main content in <main id="main">.'],
    example: { before: '<body>\n  <header>…</header>', after: '<body>\n  <a class="skip-link" href="#main">Skip to main content</a>\n  <header>…</header>\n  <main id="main">…</main>' },
    effort: 'moderate',
  }),
  'skip-link': () => ({
    problem: 'The skip link points at a target that does not exist or is not focusable.',
    steps: ['Make sure the href matches an element id on the page and that element can receive focus (add tabindex="-1" if needed).'],
    effort: 'quick',
  }),
  'region': ({ html }) => ({
    problem: 'Some page content is outside any landmark region, so screen-reader users cannot jump to it.',
    steps: ['Wrap content in the appropriate landmark: <header>, <nav>, <main>, <aside>, <footer>, or a <section aria-label="…">.'],
    example: { before: trim(html), after: `<main>\n  ${trim(html, 160)}\n</main>` },
    effort: 'moderate',
  }),
  'landmark-one-main': () => ({
    problem: 'The page has no <main> landmark, so users cannot jump straight to the content.',
    steps: ['Wrap the primary content in a single <main> element.'],
    effort: 'quick',
  }),
  'landmark-no-duplicate-banner': () => landmarkDup('banner', '<header>'),
  'landmark-no-duplicate-contentinfo': () => landmarkDup('contentinfo', '<footer>'),
  'landmark-no-duplicate-main': () => landmarkDup('main', '<main>'),
  'landmark-banner-is-top-level': () => landmarkNested('banner', '<header>'),
  'landmark-contentinfo-is-top-level': () => landmarkNested('contentinfo', '<footer>'),
  'landmark-main-is-top-level': () => landmarkNested('main', '<main>'),
  'landmark-complementary-is-top-level': () => landmarkNested('complementary', '<aside>'),
  'landmark-unique': ({ html }) => ({
    problem: 'Several landmarks of the same type have no distinguishing label, so they are announced identically.',
    steps: ['Give each repeated landmark an aria-label, e.g. <nav aria-label="Main">, <nav aria-label="Footer">.'],
    example: { before: trim(html), after: trim(setAttr(html, 'aria-label', 'Distinct name')) },
    effort: 'quick',
  }),
  'page-has-heading-one': () => ({
    problem: 'The page has no <h1>, so its topic is not announced and the heading outline has no starting point.',
    steps: ['Add exactly one <h1> that names the page\'s main content.'],
    effort: 'quick',
  }),
  'heading-order': ({ html }) => ({
    problem: `Heading levels skip (e.g. an <h4> directly under an <h2>), so the outline screen-reader users navigate by is misleading.`,
    steps: ['Use heading levels in order (h1 → h2 → h3). Style headings with CSS, not by picking a level for its size.'],
    example: { before: trim(html), after: trim(html.replace(/<(\/?)h[3-6]/gi, '<$1h2')) , note: 'Adjust to the level that fits the section, one step below its parent heading.' },
    effort: 'quick',
  }),
  'empty-heading': ({ html }) => ({
    problem: 'This heading is empty, so screen readers announce a heading with no text.',
    steps: ['Put text in the heading, or remove the empty element.'],
    example: { before: trim(html), after: trim(html.replace(/>\s*</, '>Section title<')) },
    effort: 'quick',
  }),
  'p-as-heading': () => ({
    problem: 'Bold or large paragraph text is being used as a heading, so it is not part of the navigable outline.',
    steps: ['Mark it up as a real heading element (<h2>, <h3>…) and style it with CSS.'],
    effort: 'quick',
  }),

  /* ── colour ── */
  'color-contrast': ({ html, summary }) => {
    const c = parseContrast(summary);
    const target = Number(c.expected || 4.5);
    const sug = c.fg && c.bg ? suggestForeground(c.fg, c.bg, target) : null;
    return {
      problem: c.ratio
        ? `Text colour ${c.fg} on background ${c.bg} has a contrast of ${c.ratio}:1; WCAG requires at least ${target}:1 for this text size.`
        : 'The text does not have enough contrast against its background to be read comfortably.',
      impact: 'Low-vision and colour-blind users, and anyone on a phone in sunlight, struggle to read this text.',
      steps: [
        sug ? `Darken/lighten the text to about ${sug.hex} (${sug.ratio.toFixed(1)}:1 against ${c.bg}), or change the background.` : 'Darken the text or lighten the background until the ratio reaches the target.',
        'Check the pair with a contrast checker before shipping; large text (18pt+, or 14pt bold) only needs 3:1.',
      ],
      example: sug
        ? { before: `color: ${c.fg}; background: ${c.bg};  /* ${c.ratio}:1 */`, after: `color: ${sug.hex}; background: ${c.bg};  /* ${sug.ratio.toFixed(1)}:1 */`, note: trim(html, 160) }
        : { before: trim(html), after: trim(html), note: 'Adjust the CSS colour of this element.' },
      effort: 'quick',
    };
  },
  'link-in-text-block': () => ({
    problem: 'A link inside body text is distinguished only by colour, so colour-blind users cannot see it is a link.',
    steps: ['Underline links inside paragraphs (text-decoration: underline), or add another non-colour cue.'],
    example: { before: 'p a { text-decoration: none; }', after: 'p a { text-decoration: underline; }' },
    effort: 'quick',
  }),

  /* ── ARIA ── */
  'aria-allowed-attr': ({ html }) => ({
    problem: 'An ARIA attribute is used on an element/role that does not support it, so it is ignored or misread.',
    steps: ['Remove the unsupported aria-* attribute, or change the role to one that supports it.', 'Prefer native HTML elements (button, a, input) which need no ARIA.'],
    example: { before: trim(html), after: trim(html.replace(/\s(aria-[a-z]+)="[^"]*"/i, '')), note: 'Shown with the first aria-* attribute removed; remove the one axe names.' },
    effort: 'quick',
  }),
  'aria-valid-attr-value': ({ html }) => ({
    problem: 'An ARIA attribute has a value that is not allowed (for example aria-expanded="yes" instead of "true").',
    steps: ['Set the attribute to a valid value for its type (true/false, an existing element id, a listed token).'],
    example: { before: trim(html), after: trim(html) , note: 'Correct the value axe names in "What failed".' },
    effort: 'quick',
  }),
  'aria-valid-attr': () => ({ problem: 'An attribute starting with aria- is misspelled or does not exist.', steps: ['Correct the spelling (see the WAI-ARIA attribute list) or remove it.'], effort: 'quick' }),
  'aria-required-attr': () => ({ problem: 'The role on this element requires an ARIA attribute that is missing (e.g. a slider without aria-valuenow).', steps: ['Add the required attribute(s) named in "What failed".'], effort: 'quick' }),
  'aria-required-children': () => ({ problem: 'A composite role (list, menu, tablist…) is missing the child roles it requires.', steps: ['Give the children the expected roles (e.g. role="listitem" inside role="list"), or use native HTML lists/menus.'], effort: 'moderate' }),
  'aria-required-parent': () => ({ problem: 'An element has a role that must be inside a specific parent role.', steps: ['Wrap it in the required parent (e.g. role="tab" inside role="tablist").'], effort: 'moderate' }),
  'aria-roles': () => ({ problem: 'The role value is not a valid ARIA role.', steps: ['Use a valid role or remove the attribute.'], effort: 'quick' }),
  'aria-hidden-focus': () => ({ problem: 'Something hidden from screen readers with aria-hidden="true" can still receive keyboard focus, so keyboard users land on invisible controls.', steps: ['Either remove aria-hidden, or also make the content unfocusable (tabindex="-1", disabled, or display:none).'], effort: 'quick' }),
  'aria-hidden-body': () => ({ problem: 'aria-hidden="true" is set on <body>, hiding the entire page from assistive technology.', steps: ['Remove aria-hidden from <body>.'], effort: 'quick' }),
  'aria-progressbar-name': ({ html }) => nameFix(html, 'progressbar', 'This progress bar has no accessible name.'),
  'aria-meter-name': ({ html }) => nameFix(html, 'meter', 'This meter has no accessible name.'),
  'aria-tooltip-name': ({ html }) => nameFix(html, 'tooltip', 'This tooltip has no accessible name.'),
  'aria-dialog-name': ({ html }) => nameFix(html, 'dialog', 'This dialog has no accessible name, so users are not told what opened.'),
  'presentation-role-conflict': () => ({ problem: 'An element is marked role="presentation"/"none" but is focusable or has ARIA, which conflicts.', steps: ['Remove the presentation role, or remove the focusability/ARIA.'], effort: 'quick' }),
  'nested-interactive': () => ({ problem: 'An interactive control is nested inside another (e.g. a button inside a link), which confuses focus and announcement.', steps: ['Un-nest them: one interactive element per control.'], effort: 'moderate' }),
  'duplicate-id-aria': () => ({ problem: 'An id referenced by ARIA (aria-labelledby, aria-controls…) is used more than once, so the reference is ambiguous.', steps: ['Make every id on the page unique.'], effort: 'quick' }),
  'duplicate-id-active': () => ({ problem: 'A focusable element shares its id with another element.', steps: ['Make ids unique.'], effort: 'quick' }),
  'duplicate-id': () => ({ problem: 'Duplicate id attributes on the page.', steps: ['Make ids unique.'], effort: 'quick' }),

  /* ── keyboard & structure ── */
  'scrollable-region-focusable': ({ html }) => ({
    problem: 'A scrollable area cannot be reached with the keyboard, so keyboard users cannot scroll its content.',
    steps: ['Add tabindex="0" to the scrolling container, or make sure it contains a focusable element.'],
    example: { before: trim(html), after: trim(setAttr(html, 'tabindex', '0')) },
    effort: 'quick',
  }),
  'tabindex': ({ html }) => ({
    problem: `tabindex="${attr(html, 'tabindex') || ''}" forces an unnatural tab order.`,
    steps: ['Use tabindex="0" (natural order) or "-1" (programmatic focus only); never positive values.'],
    example: { before: trim(html), after: trim(setAttr(html, 'tabindex', '0')) },
    effort: 'quick',
  }),
  'accesskeys': () => ({ problem: 'Two elements share the same accesskey.', steps: ['Give each accesskey a unique character, or remove them.'], effort: 'quick' }),
  'focus-order-semantics': () => ({ problem: 'A focusable element has no interactive role, so its purpose is unclear when reached by keyboard.', steps: ['Use a native button/link, or add an appropriate role.'], effort: 'quick' }),
  'target-size': () => ({ problem: 'The touch target is smaller than 24×24 CSS pixels, making it hard to tap.', steps: ['Increase padding or size so the target is at least 24×24px, with spacing from neighbours.'], example: { before: '.icon-btn { padding: 2px; }', after: '.icon-btn { padding: 8px; min-width: 24px; min-height: 24px; }' }, effort: 'quick' }),
  'list': () => ({ problem: 'A <ul>/<ol> contains children other than <li>, so it is not announced as a proper list.', steps: ['Only place <li> (or script/template) directly inside lists; move other elements inside the <li>.'], effort: 'quick' }),
  'listitem': () => ({ problem: 'An <li> is not inside a <ul> or <ol>.', steps: ['Wrap list items in a list element.'], effort: 'quick' }),
  'definition-list': () => ({ problem: 'A <dl> contains elements other than dt/dd groups.', steps: ['Only use <dt>/<dd> (optionally in <div> groups) inside <dl>.'], effort: 'quick' }),
  'dlitem': () => ({ problem: '<dt>/<dd> used outside a <dl>.', steps: ['Wrap them in a <dl>.'], effort: 'quick' }),
  'td-headers-attr': () => ({ problem: 'A table cell\'s headers attribute points at ids that are not header cells in the same table.', steps: ['Reference only <th> ids in this table, or remove the attribute.'], effort: 'quick' }),
  'th-has-data-cells': () => ({ problem: 'A header cell has no data cells associated with it.', steps: ['Check the table structure; use scope="col"/"row" on headers.'], effort: 'moderate' }),
  'table-fake-caption': () => ({ problem: 'A cell is being used as the table caption.', steps: ['Use a <caption> element instead.'], effort: 'quick' }),
  'avoid-inline-spacing': () => ({ problem: 'Inline !important spacing prevents users from overriding text spacing.', steps: ['Remove !important from letter-spacing/word-spacing/line-height in inline styles.'], effort: 'quick' }),
  'video-caption': () => ({ problem: 'A video has no captions.', steps: ['Add a <track kind="captions"> file, or captions burnt into the video.'], effort: 'involved' }),
  'audio-caption': () => ({ problem: 'Audio content has no transcript or captions.', steps: ['Provide a transcript near the player or a captions track.'], effort: 'involved' }),
  'blink': () => ({ problem: '<blink> content flashes, which is distracting and can trigger seizures.', steps: ['Remove the <blink> element.'], effort: 'quick' }),
  'marquee': () => ({ problem: '<marquee> content moves and cannot be paused.', steps: ['Remove the <marquee>; if motion is needed, use CSS with a pause control.'], effort: 'quick' }),
  'server-side-image-map': () => ({ problem: 'Server-side image maps cannot be used by keyboard.', steps: ['Replace with a client-side <map> or plain links.'], effort: 'involved' }),

  /* ── hygiene rules (ours) ── */
  'https': () => ({ problem: 'The page is served over plain HTTP, so anything typed into it can be read or altered in transit.', steps: ['Serve the site over HTTPS and redirect http:// to https://.', 'Add HSTS once every page works over HTTPS.'], effort: 'moderate' }),
  'http-status': ({ details }) => ({ problem: `The page returned HTTP ${String(details.status ?? 'error')} instead of a success status.`, steps: ['Fix the server error or remove links to this page.'], effort: 'moderate' }),
  'page-unreachable': () => ({ problem: 'The page could not be loaded during the audit.', steps: ['Check that the URL is correct and the server responds within 30 seconds.'], effort: 'moderate' }),
  'doctype': () => ({ problem: 'The page has no <!DOCTYPE>, so browsers render it in quirks mode with inconsistent layout.', steps: ['Add <!DOCTYPE html> as the very first line.'], example: { before: '<html lang="en">', after: '<!DOCTYPE html>\n<html lang="en">' }, effort: 'quick' }),
  'html-lang': () => R['html-has-lang']({ html: '<html>', element: '', page: '', summary: '', details: {} }),
  'title': () => R['document-title']({ html: '', element: '', page: '', summary: '', details: {} }),
  'meta-description': () => ({ problem: 'The page has no meta description (or it is too long), so search engines and link previews invent one.', steps: ['Add <meta name="description" content="…"> of 50-160 characters that describes this page.'], example: { before: '<head>\n  <title>…</title>', after: '<head>\n  <title>…</title>\n  <meta name="description" content="One or two sentences about this page.">' }, effort: 'quick' }),
  'single-h1': () => ({ problem: 'The page has zero or several <h1> elements, so its main topic is ambiguous to users and search engines.', steps: ['Use exactly one <h1> naming the page; demote extra ones to <h2>.'], effort: 'quick' }),
  'img-alt': () => imgAltFix(''),
  'img-dimensions': ({ html }) => ({ problem: 'Images without width/height cause the layout to jump as they load (layout shift).', steps: ['Add width and height attributes matching the image\'s intrinsic size; CSS can still scale it.'], example: { before: trim(html) || '<img src="hero.jpg" alt="…">', after: trim(setAttr(setAttr(html || '<img src="hero.jpg" alt="…">', 'width', '1200'), 'height', '600')) }, effort: 'quick' }),
  'img-oversized': ({ html }) => ({ problem: 'The image file is more than twice the size it is displayed at, wasting bandwidth and slowing the page.', steps: ['Export the image at (about) its displayed size, or serve responsive sizes with srcset.', 'Convert to WebP/AVIF where possible.'], example: { before: trim(html) || '<img src="photo.jpg">', after: '<img src="photo-800.webp" srcset="photo-400.webp 400w, photo-800.webp 800w, photo-1600.webp 1600w" sizes="(max-width: 600px) 100vw, 800px" alt="…">' }, effort: 'moderate' }),
  'link-noopener': ({ html }) => ({ problem: 'A link that opens a new tab without rel="noopener" lets the opened page control this one (reverse tabnabbing) and slows the opener.', steps: ['Add rel="noopener noreferrer" to every target="_blank" link.'], example: { before: trim(html) || '<a href="…" target="_blank">', after: trim(setAttr(html || '<a href="…" target="_blank">', 'rel', 'noopener noreferrer')) }, effort: 'quick' }),
  'mixed-content': () => ({ problem: 'The HTTPS page loads some resources over HTTP, which browsers block or flag as insecure.', steps: ['Change the resource URLs to https:// (or protocol-relative), and host any HTTP-only assets yourself.'], effort: 'quick' }),
  'deprecated-tags': () => ({ problem: 'Obsolete HTML elements (font, center, marquee…) are used; browsers may drop support and they defeat styling.', steps: ['Replace with semantic HTML and CSS (e.g. <span class="…"> with color/text-align in CSS).'], effort: 'moderate' }),
  'console-errors': ({ details }) => ({ problem: 'JavaScript errors are logged in the console; some feature on the page is probably not working.', steps: ['Open the page in DevTools → Console, reproduce the error and fix the script.', String(details.first || '').slice(0, 200)].filter(Boolean), effort: 'moderate' }),
  'page-errors': () => ({ problem: 'An uncaught JavaScript exception occurred while loading; whatever that script does has stopped working.', steps: ['Open DevTools → Console on this page, find the stack trace and fix or guard the failing call.', 'Wrap third-party scripts so their failure cannot break the page.'], effort: 'moderate' }),
  'favicon': () => ({ problem: 'No favicon is declared, so tabs and bookmarks show a blank icon.', steps: ['Add <link rel="icon" href="/favicon.ico"> (and an SVG/PNG variant) in <head>.'], effort: 'quick' }),
  'canonical': () => ({ problem: 'No canonical URL is declared, so search engines may index duplicate versions of this page.', steps: ['Add <link rel="canonical" href="https://…/this-page"> in <head>.'], effort: 'quick' }),
  'load-time': () => ({ problem: 'The page took more than 3 seconds to reach DOM-ready.', steps: ['Compress and lazy-load images, defer non-critical scripts, enable caching/CDN.', 'Run Lighthouse for the specific bottleneck.'], effort: 'involved' }),
  'inline-handlers': () => ({ problem: 'Inline on* handlers block a strict Content-Security-Policy and scatter logic through the markup.', steps: ['Move handlers to addEventListener in a script file.'], example: { before: '<button onclick="save()">Save</button>', after: '<button id="save">Save</button>\n<script>document.getElementById("save").addEventListener("click", save);</script>' }, effort: 'moderate' }),
  'empty-buttons': ({ html }) => R['button-name']({ html, element: '', page: '', summary: '', details: {} }),
  'generic-link-text': ({ html }) => ({ problem: 'Link text like "click here" or "read more" gives no idea of the destination, especially when links are listed out of context.', steps: ['Make the link text describe the destination, e.g. "Read the 2025 sustainability report".'], example: { before: trim(html) || '<a href="…">Read more</a>', after: (html || '<a href="…">Read more</a>').replace(/>\s*(click here|read more|more|here|link)\s*</i, '>Read more about [topic]<') }, effort: 'quick' }),
  'iframe-title': ({ html }) => R['frame-title']({ html, element: '', page: '', summary: '', details: {} }),
  'table-headers': () => ({ problem: 'A data table has no header cells, so screen readers cannot relate cells to their columns.', steps: ['Mark the first row/column with <th scope="col"> / <th scope="row">.'], example: { before: '<tr><td>Name</td><td>Amount</td></tr>', after: '<tr><th scope="col">Name</th><th scope="col">Amount</th></tr>' }, effort: 'quick' }),
};

/* ── shared builders ── */

function nameFix(html: string, what: string, problem: string): Remediation {
  const guess = guessName(html);
  const tag = tagOf(html);
  const id = attr(html, 'id');
  const labelExample = id
    ? `<label for="${id}">${guess || 'Field name'}</label>\n${trim(html)}`
    : trim(setAttr(html, 'aria-label', guess || 'Field name'));
  return {
    problem,
    impact: 'Screen-reader users cannot tell what this control is for; voice-control users cannot name it.',
    steps: [
      id ? `Add a visible <label for="${id}"> next to the control (preferred), or` : 'Add a visible <label> tied to the control with for/id (preferred), or',
      `add aria-label="${guess || 'Field name'}" directly on the <${tag || what}>.`,
    ],
    example: { before: trim(html), after: labelExample, note: guess ? `"${guess}" is inferred from the element's name attribute - use the wording your users see.` : undefined },
    effort: 'quick',
  };
}

function imgAltFix(html: string): Remediation {
  const src = attr(html, 'src') || '';
  const hint = src ? src.split('/').pop()?.split('?')[0].replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ') : '';
  return {
    problem: 'This image has no alt attribute, so screen-reader users hear the file name or nothing at all.',
    impact: 'Blind users miss the information in the image; search engines cannot index it.',
    steps: [
      'If the image conveys information, add alt text that says what it shows (not "image of").',
      'If it is purely decorative, add an empty alt="" so it is skipped.',
    ],
    example: { before: trim(html) || '<img src="…">', after: trim(setAttr(html || '<img src="…">', 'alt', hint ? humanise(hint) : 'Describe the image')), note: 'Use alt="" if the image is decorative.' },
    effort: 'quick',
  };
}

function landmarkDup(role: string, tag: string): Remediation {
  return {
    problem: `The page has more than one ${role} landmark (${tag}), so screen-reader users get duplicate "${role}" entries when navigating by landmark.`,
    steps: [`Keep one top-level ${tag}; change the others to <div> or give them a different role.`],
    effort: 'quick',
  };
}
function landmarkNested(role: string, tag: string): Remediation {
  return {
    problem: `The ${role} landmark (${tag}) is nested inside another landmark, so it is not announced as a top-level region.`,
    steps: [`Move the ${tag} so it is a direct child of <body>, or change the inner element to a <div>.`],
    effort: 'quick',
  };
}

function linkFix(f: Finding): Remediation {
  const d = f.details || {};
  const status = d.status ? Number(d.status) : null;
  const link = String(d.link || f.element || '');
  const refs = Array.isArray(d.referrers) ? (d.referrers as string[]) : [f.pageUrl];
  const where = refs.length > 1 ? `on ${refs.length} pages` : `on ${refs[0]}`;
  if (status === 404 || status === 410) {
    return {
      problem: `The link ${link} returns ${status} - the page no longer exists, so visitors ${where} hit a dead end.`,
      impact: 'Visitors lose trust and leave; search engines penalise sites with many dead links.',
      steps: ['Find where the content moved and update the href, or', 'set up a 301 redirect from the old URL to the new one on the target server, or', 'remove the link if the content is gone for good.'],
      example: { before: `<a href="${link}">${String(d.linkText || 'Link text')}</a>`, after: `<a href="https://…/new-location">${String(d.linkText || 'Link text')}</a>` },
      effort: 'quick',
    };
  }
  if (status && status >= 500) {
    return { problem: `The server behind ${link} returned HTTP ${status} - it is failing, not missing.`, steps: ['Report it to whoever owns that server; re-check after the fix.', 'If it is your own server, check its error log for this URL.'], effort: 'moderate' };
  }
  if (f.ruleId === 'timeout') {
    return { problem: `${link} did not respond within 15 seconds.`, steps: ['Open the link manually; if it is down or extremely slow, remove or replace it.', 'If it works for you, the site may block automated checks - verify by hand.'], effort: 'quick' };
  }
  return { problem: `${link} could not be reached${d.error ? ` (${String(d.error)})` : ''}.`, steps: ['Check the URL for typos (protocol, domain).', 'Open it manually and replace or remove it if it is genuinely dead.'], effort: 'quick' };
}

/* ───────────────────────────── UX / visual rules ───────────────────────────── */

function visualFix(f: Finding): Remediation {
  const d = (f.details || {}) as Record<string, unknown>;
  const sel = f.element || 'the element';
  const actual = d.actual ? String(d.actual) : '';
  const expected = d.expected ? String(d.expected) : '';
  const device = d.deviceLabel ? ` on ${String(d.deviceLabel)}` : '';
  const css = (prop: string, from: string, to: string) => ({ before: `${sel} {\n  ${prop}: ${from};\n}`, after: `${sel} {\n  ${prop}: ${to};\n}` });
  const review = d.confidence === 'review' ? ['Look at the evidence image first — this check is heuristic and may be intentional.'] : [];
  switch (f.ruleId) {
    case 'ux-overlap':
      return { problem: `Two controls are drawn on top of each other${device}.`, impact: 'Users tap or click the wrong control, or cannot reach the one underneath.', steps: ['Open the page at this viewport width and find the two controls in the evidence image.', 'Give their container room to wrap (flex-wrap: wrap) or stack them below a breakpoint.', 'Remove negative margins or absolute positioning that pulls one over the other.'], example: { before: `.actions { display: flex; }`, after: `.actions { display: flex; flex-wrap: wrap; gap: 8px; }` }, effort: 'moderate' };
    case 'ux-text-overlap':
      return { problem: `Text is drawn on top of other text${device}, so neither can be read.`, impact: 'Usually appears at one screen width only: a heading wraps onto a second line and runs into the block below, or an absolutely positioned label lands on its neighbour.', steps: ['Open the page at this viewport width and find the two texts in the evidence image.', 'Remove fixed heights on the container so it grows with its text.', 'Replace absolute positioning or negative margins with normal flow, flex or grid.', 'If the heading wraps, check line-height and allow the block below to move down.'], example: { before: `.card-title { height: 24px; }\n.card-meta { margin-top: -8px; }`, after: `.card-title { min-height: 24px; }\n.card-meta { margin-top: 4px; }` }, effort: 'moderate' };
    case 'ux-text-over-control':
      return { problem: `Text collides with a control it does not belong to${device}.`, steps: [...review, 'If it is a floating label or an icon caption, this is intentional — ignore it.', 'Otherwise give the control its own row or add spacing so the text clears it.'], effort: 'quick' };
    case 'ux-occluded':
      return { problem: `This control is covered by another element${device}, so a click at its centre lands on something else.`, impact: 'The control looks available but does not respond.', steps: ['Identify the covering element named in the finding.', 'If it is a sticky header or banner, add scroll-margin/padding so content is not hidden beneath it.', 'Otherwise fix the stacking: lower its z-index, or remove the overlap.'], example: { before: `header { position: sticky; top: 0; }`, after: `header { position: sticky; top: 0; }\nhtml { scroll-padding-top: 80px; }` }, effort: 'moderate' };
    case 'ux-overlay-blocks':
      return { problem: `One overlay covers several controls${device}.`, steps: [...review, 'If this is a cookie or consent bar, confirm it can be dismissed and does not return on every page.', 'If it is not meant to be there, find why it stays open (failed script, missing close handler).'], effort: 'moderate' };
    case 'ux-overflow-x':
      return { problem: `The page is wider than the screen${device}, so it scrolls sideways.`, impact: 'Content is cut off and the layout feels broken, especially on phones.', steps: ['Inspect the elements named in the finding — they extend past the viewport.', 'Replace fixed widths with max-width: 100%, and let long words, tables and code blocks wrap or scroll inside their own container.', 'Check images and embeds have max-width: 100%.'], example: { before: `.hero img { width: 1200px; }`, after: `.hero img { width: 100%; max-width: 1200px; height: auto; }` }, effort: 'moderate' };
    case 'ux-clipped-text':
      return { problem: `Text is cut off${device}: ${actual}.`, impact: 'Users cannot read the full label or heading.', steps: ['Let the element grow (remove the fixed width/height) or allow wrapping (white-space: normal).', 'If truncation is intended, expose the full text in a title/tooltip and make sure the key words come first.'], example: css('white-space', 'nowrap', 'normal'), effort: 'quick' };
    case 'ux-touch-target':
      return { problem: `This control is ${actual}; a comfortable touch target is at least ${expected}.`, impact: 'Small targets cause mis-taps, especially for users with limited dexterity.', steps: ['Increase the clickable area with padding or min-width/min-height — the visible icon can stay the same size.', 'Keep at least 8px between neighbouring targets.'], example: { before: `${sel} { padding: 2px; }`, after: `${sel} { min-width: 44px; min-height: 44px; padding: 10px; }` }, effort: 'quick' };
    case 'ux-misaligned':
      return { problem: `This element is ${actual}.`, steps: [...review, 'Compare its margin, padding and border with its siblings — a 1-4px difference usually comes from one extra border or a different line-height.', 'Align the group with flex or grid rather than per-element offsets.'], effort: 'quick' };
    case 'ux-uneven-gap':
      return { problem: `Spacing in this group is uneven: ${actual}, expected ${expected}.`, steps: [...review, 'Use a single gap on the flex/grid container instead of per-item margins.', 'Remove one-off margins on individual items.'], example: { before: `.item { margin-bottom: 12px; }\n.item.special { margin-bottom: 20px; }`, after: `.list { display: grid; gap: 12px; }` }, effort: 'quick' };
    case 'ux-font-family':
      return { problem: `Text renders in "${actual}", which is not in the design standard (${expected}).`, impact: 'Off-brand typography; often a third-party widget or a forgotten override.', steps: ['Find the rule that sets this font-family (DevTools → Computed → font-family).', 'Replace it with the standard family, or remove the override so the element inherits it.'], example: css('font-family', `"${actual}"`, `"${expected.split(',')[0].trim()}", sans-serif`), effort: 'quick' };
    case 'ux-font-not-loaded':
      return { problem: `The web font ${expected} is declared but did not load, so a fallback font is showing.`, impact: 'Every visitor sees different typography from the design.', steps: ['Check the @font-face URL returns 200 and the correct CORS headers.', 'Preload the font and use font-display: swap.', 'Confirm the font-family name in CSS matches the @font-face name exactly.'], example: { before: `@font-face { font-family: "Brand"; src: url(/fonts/brand.woff2); }`, after: `<link rel="preload" href="/fonts/brand.woff2" as="font" type="font/woff2" crossorigin>\n@font-face { font-family: "Brand"; src: url(/fonts/brand.woff2) format("woff2"); font-display: swap; }` }, effort: 'moderate' };
    case 'ux-font-size':
      return { problem: `Font size is ${actual}; the nearest size on the type scale is ${expected}.`, steps: ['Replace the one-off size with the type-scale token.', 'If the size comes from a percentage or em on a nested element, set it explicitly from the scale.'], example: css('font-size', actual, expected), effort: 'quick' };
    case 'ux-font-weight':
      return { problem: `Font weight ${actual} is not in the design standard (${expected}).`, steps: ['Use one of the standard weights.', 'Make sure that weight of the font file is actually loaded — otherwise the browser synthesises it.'], example: css('font-weight', actual, expected.split(',')[0].trim()), effort: 'quick' };
    case 'ux-color-drift':
      return { problem: `${actual} is almost, but not exactly, the palette colour ${expected}.`, impact: 'Usually a hand-typed hex or a colour picked from a screenshot. It makes the brand colour look inconsistent.', steps: ['Replace the hard-coded value with the design token / CSS variable for this colour.'], example: css('color', actual, expected.split(' ')[0]), effort: 'quick' };
    case 'ux-color-off-palette':
      return { problem: `${actual} is not in the palette (${expected}).`, steps: ['Decide which palette colour this should be and use its token.', 'If the colour is legitimately needed, add it to the design standard so it stops being reported.'], example: css('color', actual, (expected.match(/#[0-9A-Fa-f]{6}/) || [expected])[0]), effort: 'quick' };
    case 'ux-radius':
      return { problem: `Corner radius ${actual} is not in the design standard; nearest is ${expected}.`, steps: ['Use the radius token for this component.'], example: css('border-radius', actual, expected), effort: 'quick' };
    case 'ux-spacing':
      return { problem: `Padding ${actual} is not on the spacing scale; nearest step is ${expected}.`, steps: [...review, 'Use the spacing token for this component.'], example: css('padding-inline', actual, expected), effort: 'quick' };
    case 'ux-inconsistent-type':
      return { problem: `${f.description || f.title}`, steps: [...review, 'Decide which style is correct for this kind of text and apply it everywhere.', 'Upload a design standard to have this scored against your own rules instead of the page majority.'], effort: 'quick' };
    case 'ux-near-duplicate-color':
      return { problem: `${actual} and ${expected} are nearly identical — one is probably a typo of the other.`, steps: [...review, 'Pick one and replace the other with a shared CSS variable.'], example: css('color', actual, expected), effort: 'quick' };
    default:
      return { problem: f.description || f.title, steps: [...review, 'Open the evidence image and compare the element with the design.'], effort: 'quick' };
  }
}

/* ───────────────────────────── entry point ───────────────────────────── */

export function remediate(f: Finding): Remediation {
  const details = (f.details || {}) as Record<string, unknown>;
  const ctx: Ctx = {
    html: f.htmlSnippet || '',
    element: f.element || '',
    page: f.pageUrl,
    summary: typeof details.failureSummary === 'string' ? details.failureSummary : '',
    details,
  };
  if (f.category === 'links') return linkFix(f);
  if (f.category === 'visual') return visualFix(f);
  const id = f.ruleId.replace(/^axe-/, '');
  const rule = R[id];
  if (rule) {
    const r = rule(ctx);
    if (f.category === 'review') {
      r.steps = ['Open the page and confirm whether this is a real problem - the scanner could not decide automatically.', ...r.steps];
    }
    return r;
  }
  // Generic fallback: axe's own failure summary already lists the acceptable fixes.
  const lines = ctx.summary.split('\n').map((s) => s.trim()).filter(Boolean);
  return {
    problem: f.description || f.title,
    steps: lines.length ? lines.filter((l) => !/^Fix (any|all) of the following:?$/i.test(l)) : ['See the guidance link for this rule.'],
    example: ctx.html ? { before: trim(ctx.html), after: trim(ctx.html), note: 'Apply one of the fixes above to this element.' } : undefined,
    effort: severityEffort(f.severity),
  };
}

function severityEffort(s: Severity): Effort {
  return s === 'critical' || s === 'serious' ? 'moderate' : 'quick';
}

/** Attach guidance to a finding in place (idempotent). */
export function withRemediation(f: Finding): Finding {
  const details = { ...(f.details || {}) } as Record<string, unknown>;
  if (!details.remediation) details.remediation = remediate(f);
  return { ...f, details };
}
