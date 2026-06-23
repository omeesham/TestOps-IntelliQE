/**
 * GCP Cloud Storage provider.
 * Env vars: GCP_PROJECT_ID, GCP_STORAGE_BUCKET, GOOGLE_APPLICATION_CREDENTIALS
 */
import type { IBlobStorage, BlobMetadata } from './index.js';

export class GcsStorage implements IBlobStorage {
  private bucketName: string;
  private clientPromise: Promise<import('@google-cloud/storage').Bucket>;

  constructor() {
    this.bucketName = process.env.GCP_STORAGE_BUCKET || '';
    if (!this.bucketName) throw new Error('GCP_STORAGE_BUCKET is required for STORAGE_PROVIDER=gcs');
    this.clientPromise = this.init();
  }

  private async init() {
    const { Storage } = await import('@google-cloud/storage');
    const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });
    return storage.bucket(this.bucketName);
  }

  async put(key: string, body: Buffer | string, opts?: { contentType?: string }): Promise<string> {
    const bucket = await this.clientPromise;
    const file = bucket.file(key);
    await file.save(typeof body === 'string' ? Buffer.from(body, 'utf8') : body, {
      contentType: opts?.contentType,
      resumable: false,
    });
    return key;
  }

  async get(key: string): Promise<Buffer> {
    const bucket = await this.clientPromise;
    const [buf] = await bucket.file(key).download();
    return buf;
  }

  async exists(key: string): Promise<boolean> {
    const bucket = await this.clientPromise;
    const [exists] = await bucket.file(key).exists();
    return exists;
  }

  async list(prefix = '', opts?: { maxResults?: number }): Promise<BlobMetadata[]> {
    const bucket = await this.clientPromise;
    const [files] = await bucket.getFiles({ prefix, maxResults: opts?.maxResults });
    return files.map((f) => ({
      name: f.name,
      size: Number(f.metadata.size) || 0,
      contentType: f.metadata.contentType,
      lastModified: f.metadata.updated,
    }));
  }

  async remove(key: string): Promise<void> {
    const bucket = await this.clientPromise;
    await bucket.file(key).delete({ ignoreNotFound: true });
  }
}
