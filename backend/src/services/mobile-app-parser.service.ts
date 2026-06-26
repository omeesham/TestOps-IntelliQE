/**
 * mobile-app-parser.service.ts
 * ────────────────────────────
 * Extract metadata from an uploaded mobile build:
 *   - Android .apk → package name, launcher activity, version, permissions
 *   - iOS .ipa     → CFBundleIdentifier, display name, version
 *
 * Parsing is best-effort and ALWAYS degrades gracefully: a build we can't fully
 * parse still returns a usable record (platform + file name + a `warning`) so the
 * generation flow is never blocked. Parallel to document-parser.service.ts.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export type MobilePlatform = 'android' | 'ios';

export interface MobileAppMetadata {
  platform: MobilePlatform;
  fileName: string;
  sizeBytes: number;
  appName?: string;
  /** Android package name, e.g. com.example.app */
  packageName?: string;
  /** Android launcher activity */
  mainActivity?: string;
  /** iOS bundle identifier, e.g. com.example.app */
  bundleId?: string;
  versionName?: string;
  versionCode?: string;
  permissions?: string[];
  warning?: string;
}

function platformFromName(fileName: string): MobilePlatform | null {
  const ext = (fileName.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  if (ext === 'apk') return 'android';
  if (ext === 'ipa') return 'ios';
  return null;
}

/** Coerce app-info-parser's `application.label` (string | string[]) to a string. */
function firstString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

export async function parseMobileApp(buffer: Buffer, fileName: string): Promise<MobileAppMetadata> {
  const platform = platformFromName(fileName);
  if (!platform) {
    throw new Error('Unsupported file. Upload an Android .apk or iOS .ipa build.');
  }

  const meta: MobileAppMetadata = { platform, fileName, sizeBytes: buffer.length };

  // app-info-parser wants a real file path in Node, so stage the upload to a
  // temp file, parse, then delete it. The buffer never touches permanent disk.
  const tmp = path.join(os.tmpdir(), `iqe-app-${crypto.randomUUID()}.${platform === 'android' ? 'apk' : 'ipa'}`);
  try {
    await fs.writeFile(tmp, buffer);

    const mod: any = await import('app-info-parser');
    const AppInfoParser = mod.default || mod;
    const result: any = await new AppInfoParser(tmp).parse();

    if (platform === 'android') {
      meta.packageName = result?.package || undefined;
      meta.versionName = result?.versionName != null ? String(result.versionName) : undefined;
      meta.versionCode = result?.versionCode != null ? String(result.versionCode) : undefined;
      meta.mainActivity = result?.launchableActivity || result?.application?.launchActivity || undefined;
      meta.appName = firstString(result?.application?.label) || firstString(result?.label);
      meta.permissions = Array.isArray(result?.usesPermissions)
        ? result.usesPermissions.map((p: unknown) => String(p)).slice(0, 60)
        : undefined;
    } else {
      meta.bundleId = result?.CFBundleIdentifier || undefined;
      meta.appName = result?.CFBundleDisplayName || result?.CFBundleName || undefined;
      meta.versionName = result?.CFBundleShortVersionString != null ? String(result.CFBundleShortVersionString) : undefined;
      meta.versionCode = result?.CFBundleVersion != null ? String(result.CFBundleVersion) : undefined;
      const perms = result?.UIRequiredDeviceCapabilities;
      meta.permissions = Array.isArray(perms) ? perms.map((p: unknown) => String(p)).slice(0, 60) : undefined;
    }

    if (!meta.appName) meta.appName = fileName.replace(/\.(apk|ipa)$/i, '');
    if (!meta.packageName && !meta.bundleId) {
      meta.warning = 'Could not read the app identifier from the build; using the file name. You can still proceed.';
    }
    return meta;
  } catch (err) {
    // Never block the flow on a parse failure — return what we know.
    meta.appName = fileName.replace(/\.(apk|ipa)$/i, '');
    meta.warning = `Could not fully parse the ${platform === 'android' ? 'APK' : 'IPA'}: ${(err as Error).message}. Proceeding with the file name only.`;
    return meta;
  } finally {
    fs.unlink(tmp).catch(() => { /* best-effort cleanup */ });
  }
}
