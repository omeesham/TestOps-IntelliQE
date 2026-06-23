/**
 * Local filesystem storage — dev / on-prem fallback.
 * Root directory is `STORAGE_LOCAL_DIR` (defaults to `./artifacts/`).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IBlobStorage, BlobMetadata } from './index.js';

export class LocalStorage implements IBlobStorage {
  private root: string;

  constructor() {
    this.root = path.resolve(process.env.STORAGE_LOCAL_DIR || './artifacts');
  }

  private resolve(key: string): string {
    // Reject path traversal
    const safe = key.replace(/^[/\\]+/, '').replace(/\.\./g, '');
    return path.join(this.root, safe);
  }

  async put(key: string, body: Buffer | string): Promise<string> {
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
    return key;
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix = '', opts?: { maxResults?: number }): Promise<BlobMetadata[]> {
    const start = this.resolve(prefix);
    const out: BlobMetadata[] = [];
    const max = opts?.maxResults ?? 1000;
    async function walk(dir: string): Promise<void> {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= max) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else {
          const stat = await fs.stat(full);
          out.push({ name: full, size: stat.size, lastModified: stat.mtime.toISOString() });
        }
      }
    }
    await walk(start);
    return out;
  }

  async remove(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(key));
    } catch {
      /* idempotent */
    }
  }
}
