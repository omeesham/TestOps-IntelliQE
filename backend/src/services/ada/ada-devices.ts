/**
 * Device profiles for UX testing.
 *
 * The audit's main pass (accessibility, links, best practices) runs once at
 * desktop. The UX checks additionally run on each selected profile, because
 * overlaps, clipped text, sideways scrolling and small touch targets are
 * driven by screen width and input type.
 *
 * Honest scope: profiles are emulated in Chromium — viewport, pixel density,
 * touch and user agent. That reproduces responsive layout faithfully; it is
 * not Safari's or Samsung Internet's rendering engine. The report says so.
 *
 * Values are CSS viewport sizes (not physical pixels). Phones are picked to
 * cover the distinct widths in circulation (360 / 393-402 / 412 / 430-440),
 * since layout bugs follow width, not model name. Refresh this list yearly.
 */

export type DeviceKind = 'desktop' | 'tablet' | 'mobile';

export interface DeviceProfile {
  id: string;
  label: string;
  kind: DeviceKind;
  vendor?: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  userAgent?: string;
  /** Pre-selected in the audit form. */
  recommended?: boolean;
}

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const androidUa = (model: string) => `Mozilla/5.0 (Linux; Android 15; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36`;

/** The desktop profile the main audit pass uses. Always part of a UX run. */
export const PRIMARY_DEVICE_ID = 'desktop-1366';

export const DEVICE_PROFILES: DeviceProfile[] = [
  // ── desktop ──
  { id: 'desktop-1366', label: 'Desktop 1366 × 900', kind: 'desktop', viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, recommended: true },
  { id: 'desktop-1920', label: 'Desktop 1920 × 1080', kind: 'desktop', viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { id: 'laptop-1280', label: 'Laptop 1280 × 720', kind: 'desktop', viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  // ── phones (one per distinct width is recommended) ──
  { id: 'galaxy-s25', label: 'Samsung Galaxy S25', vendor: 'Samsung', kind: 'mobile', viewport: { width: 360, height: 780 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: androidUa('SM-S931B'), recommended: true },
  { id: 'iphone-17-pro', label: 'iPhone 17 Pro', vendor: 'Apple', kind: 'mobile', viewport: { width: 402, height: 874 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IOS_UA, recommended: true },
  { id: 'pixel-10', label: 'Google Pixel 10', vendor: 'Google', kind: 'mobile', viewport: { width: 412, height: 923 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, userAgent: androidUa('Pixel 10'), recommended: true },
  { id: 'iphone-17-pro-max', label: 'iPhone 17 Pro Max', vendor: 'Apple', kind: 'mobile', viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IOS_UA, recommended: true },
  { id: 'iphone-16', label: 'iPhone 16 / 15', vendor: 'Apple', kind: 'mobile', viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IOS_UA },
  { id: 'iphone-se', label: 'iPhone SE (smallest in use)', vendor: 'Apple', kind: 'mobile', viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IOS_UA },
  { id: 'galaxy-s25-ultra', label: 'Samsung Galaxy S25 Ultra', vendor: 'Samsung', kind: 'mobile', viewport: { width: 384, height: 824 }, deviceScaleFactor: 3.75, isMobile: true, hasTouch: true, userAgent: androidUa('SM-S938B') },
  // ── tablets ──
  { id: 'ipad-air', label: 'iPad Air 11"', vendor: 'Apple', kind: 'tablet', viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPAD_UA },
  { id: 'galaxy-tab-s10', label: 'Samsung Galaxy Tab S10', vendor: 'Samsung', kind: 'tablet', viewport: { width: 800, height: 1280 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: androidUa('SM-X710') },
];

export const RECOMMENDED_DEVICE_IDS = DEVICE_PROFILES.filter((d) => d.recommended).map((d) => d.id);

/** Resolve ids to profiles: unknown ids dropped, primary desktop always first, capped. */
export function resolveDevices(ids: unknown, max = 8): DeviceProfile[] {
  const wanted = Array.isArray(ids) ? ids.map(String) : [];
  const out: DeviceProfile[] = [DEVICE_PROFILES.find((d) => d.id === PRIMARY_DEVICE_ID)!];
  for (const id of wanted) {
    const d = DEVICE_PROFILES.find((p) => p.id === id);
    if (d && !out.includes(d)) out.push(d);
    if (out.length >= max) break;
  }
  return out;
}
