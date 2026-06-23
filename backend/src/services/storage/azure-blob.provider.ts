/**
 * Azure Blob Storage provider.
 * Env vars: AZURE_STORAGE_CONNECTION_STRING, AZURE_STORAGE_CONTAINER
 */
import type { IBlobStorage, BlobMetadata } from './index.js';

export class AzureBlobStorage implements IBlobStorage {
  private container: string;
  private mod!: typeof import('@azure/storage-blob');
  private clientPromise: Promise<import('@azure/storage-blob').ContainerClient>;

  constructor() {
    const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
    this.container = process.env.AZURE_STORAGE_CONTAINER || 'intelliqe-artifacts';
    if (!connStr) throw new Error('AZURE_STORAGE_CONNECTION_STRING is required for STORAGE_PROVIDER=azure-blob');
    this.clientPromise = this.init(connStr);
  }

  private async init(connStr: string) {
    this.mod = await import('@azure/storage-blob');
    const service = this.mod.BlobServiceClient.fromConnectionString(connStr);
    return service.getContainerClient(this.container);
  }

  async put(key: string, body: Buffer | string, opts?: { contentType?: string }): Promise<string> {
    const client = await this.clientPromise;
    const blob = client.getBlockBlobClient(key);
    const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    await blob.uploadData(buf, {
      blobHTTPHeaders: opts?.contentType ? { blobContentType: opts.contentType } : undefined,
    });
    return key;
  }

  async get(key: string): Promise<Buffer> {
    const client = await this.clientPromise;
    const blob = client.getBlockBlobClient(key);
    return blob.downloadToBuffer();
  }

  async exists(key: string): Promise<boolean> {
    const client = await this.clientPromise;
    return client.getBlockBlobClient(key).exists();
  }

  async list(prefix = '', opts?: { maxResults?: number }): Promise<BlobMetadata[]> {
    const client = await this.clientPromise;
    const out: BlobMetadata[] = [];
    const max = opts?.maxResults ?? 1000;
    for await (const blob of client.listBlobsFlat({ prefix })) {
      out.push({
        name: blob.name,
        size: blob.properties.contentLength ?? 0,
        contentType: blob.properties.contentType,
        lastModified: blob.properties.lastModified?.toISOString(),
      });
      if (out.length >= max) break;
    }
    return out;
  }

  async remove(key: string): Promise<void> {
    const client = await this.clientPromise;
    await client.getBlockBlobClient(key).deleteIfExists();
  }
}
