/**
 * test-data.service
 * ─────────────────
 * Test files per application under test (e.g. documents or images that an
 * upload feature needs). Uploaded in System Configuration → Application Setup
 * and stored at <TEST_DATA_ROOT>/<tenantId>/<appId>/<file>.
 *
 * At run time the files are copied into the Playwright workspace's
 * `test-data/` folder, with generated invalid files for negative upload tests
 * (empty, corrupt, wrong type, oversized). Specs find the folder through
 * IQE_TEST_DATA_DIR (set by the runner), falling back to `<spec dir>/../test-data`.
 *
 * Storage: container file systems are not persistent; in production point
 * TEST_DATA_DIR at a persistent volume (e.g. an Azure Files mount).
 */
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AppContext } from '../agents/state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

export const TEST_DATA_ROOT = process.env.TEST_DATA_DIR || path.join(BACKEND_ROOT, 'test-data-store');

/** Env var the Playwright runner sets so specs find the workspace's test-data folder. */
export const TEST_DATA_ENV = 'IQE_TEST_DATA_DIR';

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,120}$/;
export const MAX_FILES_PER_APP = 200;

/** Generated invalid files, available to every app that has test files. */
export const NEGATIVE_FILES: { name: string; description: string }[] = [
  { name: 'negative-empty.pdf', description: 'empty file (0 bytes)' },
  { name: 'negative-corrupt.pdf', description: 'damaged PDF (valid header, broken body)' },
  { name: 'negative-not-a-pdf.pdf', description: 'plain text renamed to .pdf' },
  { name: 'negative-wrong-type.txt', description: 'text file (usually an unsupported type)' },
  { name: 'negative-oversized.pdf', description: `PDF of ${oversizeMb()} MB, for size limits` },
];

function oversizeMb(): number {
  const n = parseInt(process.env.TEST_DATA_OVERSIZE_MB || '', 10);
  return Number.isFinite(n) && n > 0 && n <= 200 ? n : 11;
}

/** A stored file name: the uploaded name restricted to a safe character set. */
export function sanitizeTestDataName(raw: string): string | null {
  const base = path.basename(String(raw || '')).replace(/\s+/g, '_').replace(/[^A-Za-z0-9._-]/g, '');
  if (!base || base.startsWith('.') || !SAFE_SEGMENT.test(base)) return null;
  if (NEGATIVE_FILES.some((n) => n.name === base)) return null; // reserved
  return base;
}

/** Absolute storage folder for one application's files. */
export function appTestDataDir(tenantId: string, appId: string): string {
  const safe = (s: string) => SAFE_SEGMENT.test(s) && !/^\.+$/.test(s);
  if (!safe(tenantId) || !safe(appId)) {
    throw new Error('Invalid tenant or application id');
  }
  return path.join(TEST_DATA_ROOT, tenantId, appId);
}

export interface TestDataFile { name: string; size: number; updatedAt: string }

export async function listTestData(tenantId: string, appId: string): Promise<TestDataFile[]> {
  const dir = appTestDataDir(tenantId, appId);
  if (!existsSync(dir)) return [];
  const out: TestDataFile[] = [];
  for (const name of (await fs.readdir(dir)).sort()) {
    const st = await fs.stat(path.join(dir, name)).catch(() => null);
    if (st?.isFile()) out.push({ name, size: st.size, updatedAt: st.mtime.toISOString() });
  }
  return out;
}

/** Store an uploaded file (moved from its temporary upload path). */
export async function saveTestData(tenantId: string, appId: string, rawName: string, tempPath: string): Promise<string> {
  const name = sanitizeTestDataName(rawName);
  if (!name) throw new Error(`Invalid file name: ${rawName}`);
  const dir = appTestDataDir(tenantId, appId);
  await fs.mkdir(dir, { recursive: true });
  const existing = await fs.readdir(dir);
  if (!existing.includes(name) && existing.length >= MAX_FILES_PER_APP) {
    throw new Error(`An application can hold at most ${MAX_FILES_PER_APP} test files`);
  }
  // copy + unlink rather than rename: the temp folder may be on another volume.
  await fs.copyFile(tempPath, path.join(dir, name));
  return name;
}

export async function deleteTestData(tenantId: string, appId: string, rawName: string): Promise<boolean> {
  const name = path.basename(String(rawName || ''));
  if (!SAFE_SEGMENT.test(name) || /^\.+$/.test(name)) return false;
  const file = path.join(appTestDataDir(tenantId, appId), name);
  if (!existsSync(file)) return false;
  await fs.unlink(file);
  return true;
}

export async function deleteAllTestData(tenantId: string, appId: string): Promise<void> {
  await fs.rm(appTestDataDir(tenantId, appId), { recursive: true, force: true });
}

/** Fields to merge into an AppContext so agents know the app's files ({} when it has none). */
export async function testDataContext(tenantId: string, appId: string): Promise<Pick<AppContext, 'testDataFiles'>> {
  try {
    const files = await listTestData(tenantId, appId);
    return files.length ? { testDataFiles: files.map((f) => f.name) } : {};
  } catch {
    return {};
  }
}

/**
 * Copy an app's stored files into `destDir` and write the generated invalid
 * files beside them. Returns the file names now present.
 */
export async function materializeTestData(sourceDir: string, destDir: string): Promise<string[]> {
  await fs.mkdir(destDir, { recursive: true });
  const names: string[] = [];
  if (existsSync(sourceDir)) {
    for (const name of await fs.readdir(sourceDir)) {
      const src = path.join(sourceDir, name);
      if ((await fs.stat(src)).isFile()) {
        await fs.copyFile(src, path.join(destDir, name));
        names.push(name);
      }
    }
  }
  await fs.writeFile(path.join(destDir, 'negative-empty.pdf'), Buffer.alloc(0));
  await fs.writeFile(path.join(destDir, 'negative-corrupt.pdf'),
    Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog'), Buffer.from([0x00, 0xff, 0x13, 0x37, 0x00]), Buffer.from('\n%%broken')]));
  await fs.writeFile(path.join(destDir, 'negative-not-a-pdf.pdf'), 'This is plain text, not a PDF document.\n');
  await fs.writeFile(path.join(destDir, 'negative-wrong-type.txt'), 'Plain text file used to test file-type validation.\n');
  const big = Buffer.alloc(oversizeMb() * 1024 * 1024 + 1024, 0x20);
  Buffer.from('%PDF-1.4\n').copy(big, 0);
  await fs.writeFile(path.join(destDir, 'negative-oversized.pdf'), big);
  names.push(...NEGATIVE_FILES.map((n) => n.name));
  return names;
}

/** Spec code that resolves the test-data folder (runner env, else the suite layout). */
export const TEST_DATA_DIR_DECL =
  `const TEST_DATA_DIR = process.env.${TEST_DATA_ENV} || path.join(__dirname, '../test-data');`;

function fileListLines(files: string[]): string {
  const real = files.map((n) => `  - ${n}`).join('\n');
  const neg = NEGATIVE_FILES.map((n) => `  - ${n.name} — ${n.description}`).join('\n');
  return `Real files:\n${real}\nGenerated invalid files (for negative upload tests):\n${neg}`;
}

/**
 * Prompt block listing the available files ('' when there are none).
 *   'cases':  test-case generation — use the exact file names
 *   'script': spec generation — the setInputFiles pattern
 */
export function testDataPromptBlock(files: string[] | undefined, mode: 'cases' | 'script'): string {
  if (!files?.length) return '';
  const list = fileListLines(files);
  if (mode === 'cases') {
    return `\nTEST FILES available for upload scenarios (use these EXACT file names in steps and testData; never invent file names):\n${list}\n- Cover positive uploads (real files) and negative uploads (the generated invalid files) where the app has an upload.\n`;
  }
  return `\nTEST FILES (upload them with setInputFiles; use ONLY these file names, never invent files or paths):\n${list}\nUpload pattern (exactly this — the folder is resolved at run time):\nimport path from 'path';\n${TEST_DATA_DIR_DECL}\nawait <file input locator>.setInputFiles(path.join(TEST_DATA_DIR, '<file name>'));\n- File inputs are often hidden behind a styled button: target the <input type="file"> itself; setInputFiles works on hidden inputs.\n`;
}

/** True when a spec reads the test-data folder. */
export function specUsesTestData(code: string): boolean {
  return code.includes(TEST_DATA_ENV) || code.includes('TEST_DATA_DIR');
}
