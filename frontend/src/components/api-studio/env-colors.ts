/**
 * Environment colours — the Postman-style visual tag.
 *
 * An environment can carry a colour so dev / staging / prod are told apart at a
 * glance wherever the environment appears (the picker, the cards, the run log).
 * Purely presentational: nothing in the run pipeline reads a colour.
 *
 * A fixed swatch palette keeps the tags coherent with the app's surface, while
 * a stored value is still just a `#rrggbb` string — a hand-set colour renders
 * fine even if it is not one of these.
 */

export interface EnvColor { hex: string; label: string }

/** The offered swatches — a calm spread that reads on the app's light surface. */
export const ENV_COLORS: EnvColor[] = [
  { hex: '#7c3aed', label: 'Violet' },
  { hex: '#6366f1', label: 'Indigo' },
  { hex: '#2563eb', label: 'Blue' },
  { hex: '#0891b2', label: 'Cyan' },
  { hex: '#059669', label: 'Green' },
  { hex: '#65a30d', label: 'Lime' },
  { hex: '#d97706', label: 'Amber' },
  { hex: '#ea580c', label: 'Orange' },
  { hex: '#dc2626', label: 'Red' },
  { hex: '#db2777', label: 'Pink' },
  { hex: '#4b5563', label: 'Slate' },
];

/** Default colour for a brand-new environment (the app's own violet). */
export const DEFAULT_ENV_COLOR = ENV_COLORS[0]!.hex;

/** The colour to render for an environment, falling back to a neutral swatch. */
export function envColor(color: string | undefined | null): string {
  const c = String(color || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#9ca3af';
}

/**
 * Standard deployment tiers offered as quick-pick names, each with a
 * conventional colour (cool → dev, hot → prod) so the promotion path reads at a
 * glance. Names are only suggestions — any custom name is still allowed.
 */
export interface EnvPreset { name: string; color: string }
export const ENV_PRESETS: EnvPreset[] = [
  { name: 'DEV', color: '#2563eb' },     // blue
  { name: 'TEST', color: '#0891b2' },    // cyan
  { name: 'STAGE', color: '#d97706' },   // amber
  { name: 'PREPROD', color: '#ea580c' }, // orange
  { name: 'PROD', color: '#dc2626' },    // red
];

/** The conventional colour for a tier name, if it is one of the presets. */
export function presetColor(name: string): string | undefined {
  const n = String(name || '').trim().toUpperCase();
  return ENV_PRESETS.find((p) => p.name === n)?.color;
}
