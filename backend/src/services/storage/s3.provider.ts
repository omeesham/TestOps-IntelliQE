/**
 * AWS S3 provider.
 * Env vars: AWS_REGION, AWS_S3_BUCKET, plus standard AWS SDK credential chain
 * (env vars, IAM role, ~/.aws/credentials, etc.).
 */
import type { IBlobStorage, BlobMetadata } from './index.js';

export class S3Storage implements IBlobStorage {
  private bucket: string;
  private region: string;
  private clientPromise: Promise<import('@aws-sdk/client-s3').S3Client>;
  private mod!: typeof import('@aws-sdk/client-s3');

  constructor() {
    this.bucket = process.env.AWS_S3_BUCKET || '';
    this.region = process.env.AWS_REGION || 'us-east-1';
    if (!this.bucket) throw new Error('AWS_S3_BUCKET is required for STORAGE_PROVIDER=s3');
    this.clientPromise = this.init();
  }

  private async init() {
    this.mod = await import('@aws-sdk/client-s3');
    return new this.mod.S3Client({ region: this.region });
  }

  async put(key: string, body: Buffer | string, opts?: { contentType?: string }): Promise<string> {
    const client = await this.clientPromise;
    await client.send(
      new this.mod.PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: typeof body === 'string' ? Buffer.from(body, 'utf8') : body,
        ContentType: opts?.contentType,
      }),
    );
    return key;
  }

  async get(key: string): Promise<Buffer> {
    const client = await this.clientPromise;
    const res = await client.send(new this.mod.GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const chunks: Buffer[] = [];
    const stream = res.Body as NodeJS.ReadableStream;
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  async exists(key: string): Promise<boolean> {
    const client = await this.clientPromise;
    try {
      await client.send(new this.mod.HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix = '', opts?: { maxResults?: number }): Promise<BlobMetadata[]> {
    const client = await this.clientPromise;
    const max = opts?.maxResults ?? 1000;
    const out: BlobMetadata[] = [];
    let token: string | undefined;
    do {
      const res = await client.send(
        new this.mod.ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
          MaxKeys: Math.min(1000, max - out.length),
        }),
      );
      for (const obj of res.Contents || []) {
        out.push({
          name: obj.Key || '',
          size: obj.Size || 0,
          lastModified: obj.LastModified?.toISOString(),
        });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token && out.length < max);
    return out;
  }

  async remove(key: string): Promise<void> {
    const client = await this.clientPromise;
    await client.send(new this.mod.DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
