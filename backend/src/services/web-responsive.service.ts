/**
 * web-responsive.service.ts
 * ─────────────────────────
 * Responsive / device-emulation preview — a standalone, opt-in Web Lab tool.
 * Renders a URL across real device descriptors (viewport + user-agent +
 * device-scale + touch) using Playwright's `devices` registry, emulated on the
 * installed Chromium. Lives alongside the pipeline and never touches it.
 */
import { withPage, assertWebUrl } from './web-browser.service.js';

/** A curated set of common devices — validated against Playwright's registry at use. */
export const DEVICE_PRESETS = [
  'iPhone 13', 'iPhone 13 Pro Max', 'iPhone SE', 'Pixel 7', 'Galaxy S9+',
  'iPad (gen 7)', 'iPad Pro 11', 'Desktop Chrome',
];

const PNG_BASE64_LIMIT = 6_000_000;

export interface DeviceCell {
  device: string;
  ok: boolean;
  width?: number; height?: number; isMobile?: boolean; deviceScaleFactor?: number;
  pngBase64?: string;
  error?: string;
}
export interface DeviceReport { url: string; cells: DeviceCell[]; capturedAt: string }

export async function listDevicePresets(): Promise<string[]> {
  const pw = await import('@playwright/test');
  return DEVICE_PRESETS.filter((d) => !!pw.devices[d]);
}

export async function captureDevices(input: { url: unknown; devices?: unknown; fullPage?: unknown }): Promise<DeviceReport> {
  const url = assertWebUrl(input.url);
  const pw = await import('@playwright/test');
  const requested = Array.isArray(input.devices) && input.devices.length ? input.devices.map(String) : ['iPhone 13', 'iPad (gen 7)', 'Desktop Chrome'];
  const names = requested.filter((d) => !!pw.devices[d]).slice(0, 6);
  const fullPage = !!input.fullPage;

  const cells: DeviceCell[] = [];
  for (const name of names) {
    const desc = pw.devices[name];
    try {
      const png = await withPage(url, async (page) => {
        await page.waitForTimeout(400);
        return page.screenshot({ type: 'png', fullPage });
      }, {
        engine: 'chromium', // emulate the device on Chromium (always installed)
        context: { viewport: desc.viewport, userAgent: desc.userAgent, deviceScaleFactor: desc.deviceScaleFactor, isMobile: desc.isMobile, hasTouch: desc.hasTouch },
        waitUntil: 'networkidle', gotoTimeoutMs: 45_000,
      });
      const b64 = png.toString('base64');
      cells.push({
        device: name, ok: true,
        width: desc.viewport.width, height: desc.viewport.height, isMobile: desc.isMobile, deviceScaleFactor: desc.deviceScaleFactor,
        pngBase64: b64.length > PNG_BASE64_LIMIT ? undefined : b64,
        error: b64.length > PNG_BASE64_LIMIT ? 'Screenshot too large to preview' : undefined,
      });
    } catch (err) {
      cells.push({ device: name, ok: false, error: (err as Error).message });
    }
  }
  return { url, cells, capturedAt: new Date().toISOString() };
}
