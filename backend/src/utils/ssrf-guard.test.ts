import { describe, it, expect, afterEach } from 'vitest';
import { classifyIp, blockReasonForIp, assertUrlAllowed } from './ssrf-guard';

const SAVE = { ...process.env };
afterEach(() => { process.env = { ...SAVE }; });

describe('classifyIp', () => {
  it('classifies cloud-metadata addresses', () => {
    expect(classifyIp('169.254.169.254')).toBe('metadata'); // AWS/GCP/Azure IMDS
    expect(classifyIp('169.254.170.2')).toBe('metadata');   // ECS
    expect(classifyIp('::ffff:169.254.169.254')).toBe('metadata'); // IPv4-mapped
    expect(classifyIp('fd00:ec2::254')).toBe('metadata');   // AWS IPv6 IMDS
  });
  it('classifies IPv4 ranges', () => {
    expect(classifyIp('127.0.0.1')).toBe('loopback');
    expect(classifyIp('10.1.2.3')).toBe('private');
    expect(classifyIp('172.16.5.5')).toBe('private');
    expect(classifyIp('192.168.1.1')).toBe('private');
    expect(classifyIp('100.64.0.1')).toBe('private');       // CGNAT
    expect(classifyIp('169.254.10.10')).toBe('linklocal');
    expect(classifyIp('224.0.0.1')).toBe('multicast');
    expect(classifyIp('0.0.0.0')).toBe('unspecified');
    expect(classifyIp('8.8.8.8')).toBe('public');
    expect(classifyIp('1.1.1.1')).toBe('public');
  });
  it('classifies IPv6 ranges', () => {
    expect(classifyIp('::1')).toBe('loopback');
    expect(classifyIp('::')).toBe('unspecified');
    expect(classifyIp('fe80::1')).toBe('linklocal');
    expect(classifyIp('fc00::1')).toBe('private');
    expect(classifyIp('fd12:3456::1')).toBe('private');
    expect(classifyIp('ff02::1')).toBe('multicast');
    expect(classifyIp('::ffff:10.0.0.1')).toBe('private');  // mapped private
    expect(classifyIp('2606:4700:4700::1111')).toBe('public');
  });
});

describe('blockReasonForIp', () => {
  it('always blocks metadata even when private is allowed', () => {
    expect(blockReasonForIp('169.254.169.254', true)).toMatch(/metadata/);
  });
  it('blocks private/loopback only when private is NOT allowed', () => {
    expect(blockReasonForIp('10.0.0.5', false)).toMatch(/private/);
    expect(blockReasonForIp('10.0.0.5', true)).toBeNull();
    expect(blockReasonForIp('127.0.0.1', false)).toMatch(/loopback/);
    expect(blockReasonForIp('127.0.0.1', true)).toBeNull();
  });
  it('always blocks reserved/multicast/unspecified', () => {
    expect(blockReasonForIp('0.0.0.0', true)).toMatch(/unspecified/);
    expect(blockReasonForIp('224.0.0.1', true)).toMatch(/multicast/);
    expect(blockReasonForIp('240.0.0.1', true)).toMatch(/reserved/);
  });
  it('never blocks public addresses', () => {
    expect(blockReasonForIp('8.8.8.8', false)).toBeNull();
  });
});

describe('assertUrlAllowed (with private blocked)', () => {
  function block() { process.env.SSRF_ALLOW_PRIVATE = 'false'; delete process.env.SSRF_ALLOWED_HOSTS; }

  it('rejects the cloud-metadata endpoint', async () => {
    block();
    await expect(assertUrlAllowed('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/SSRF blocked.*metadata/);
  });
  it('rejects private and loopback literal IPs', async () => {
    block();
    await expect(assertUrlAllowed('http://10.0.0.5/admin')).rejects.toThrow(/SSRF blocked/);
    await expect(assertUrlAllowed('http://127.0.0.1:9200/')).rejects.toThrow(/SSRF blocked/);
    await expect(assertUrlAllowed('http://[::1]/')).rejects.toThrow(/SSRF blocked/);
  });
  it('rejects a non-http(s) scheme', async () => {
    block();
    await expect(assertUrlAllowed('file:///etc/passwd')).rejects.toThrow(/scheme/);
    await expect(assertUrlAllowed('gopher://x/')).rejects.toThrow(/scheme/);
  });
  it('allows a public literal IP', async () => {
    block();
    await expect(assertUrlAllowed('https://8.8.8.8/')).resolves.toBeUndefined();
  });
  it('honours the SSRF_ALLOWED_HOSTS allowlist', async () => {
    block();
    process.env.SSRF_ALLOWED_HOSTS = '10.0.0.5, internal.example.test';
    await expect(assertUrlAllowed('http://10.0.0.5/metrics')).resolves.toBeUndefined();
  });
  it('allows private targets when private access is enabled (self-hosted/dev)', async () => {
    process.env.SSRF_ALLOW_PRIVATE = 'true';
    await expect(assertUrlAllowed('http://10.0.0.5/')).resolves.toBeUndefined();
    // …but metadata stays blocked regardless
    await expect(assertUrlAllowed('http://169.254.169.254/')).rejects.toThrow(/metadata/);
  });
});
