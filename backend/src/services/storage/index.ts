/**
 * Blob storage abstraction.
 *
 * Lets the same artifact-upload code run against Azure Blob, AWS S3, GCP
 * Storage, or the local filesystem — picked by `STORAGE_PROVIDER` env var:
 *
 *   STORAGE_PROVIDER=azure-blob | s3 | gcs | local
 *
 * Each provider reads its own connection details from env vars; see
 * `.env.example`. Cloud SDKs are listed as optional dependencies so they
 * only install where actually used.
 */
export interface BlobMetadata {
  name: string;
  size: number;
  contentType?: string;
  lastModified?: string;
}

export interface IBlobStorage {
  /** Upload bytes/string to a key. Returns the canonical key/path used. */
  put(key: string, body: Buffer | string, opts?: { contentType?: string }): Promise<string>;
  /** Download bytes for a key. */
  get(key: string): Promise<Buffer>;
  /** Test connectivity. */
  exists(key: string): Promise<boolean>;
  /** List keys under a prefix. */
  list(prefix?: string, opts?: { maxResults?: number }): Promise<BlobMetadata[]>;
  /** Delete a key. */
  remove(key: string): Promise<void>;
}

let cached: IBlobStorage | null = null;

export async function getBlobStorage(): Promise<IBlobStorage> {
  if (cached) return cached;
  const provider = (process.env.STORAGE_PROVIDER || 'local').toLowerCase();
  switch (provider) {
    case 'azure-blob': {
      const { AzureBlobStorage } = await import('./azure-blob.provider.js');
      cached = new AzureBlobStorage();
      break;
    }
    case 's3': {
      const { S3Storage } = await import('./s3.provider.js');
      cached = new S3Storage();
      break;
    }
    case 'gcs': {
      const { GcsStorage } = await import('./gcs.provider.js');
      cached = new GcsStorage();
      break;
    }
    case 'local':
    default: {
      const { LocalStorage } = await import('./local.provider.js');
      cached = new LocalStorage();
      break;
    }
  }
  return cached;
}

/** For tests / hot reload. */
export function resetBlobStorageCache(): void {
  cached = null;
}
