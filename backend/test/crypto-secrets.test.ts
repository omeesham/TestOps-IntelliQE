/**
 * Unit tests for config secret handling (utils/crypto.ts): nested encryption,
 * masking, and restoring a masked value that comes back on save.
 * Run: node --import tsx --test test/*.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptField, encryptConfigData, decryptConfigData, maskConfigData,
  hasMaskedSecret, restoreMaskedSecrets,
} from '../src/utils/crypto.js';

process.env.ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');

const app = {
  appName: 'Shop',
  baseUrl: 'https://shop.example.test',
  roles: [
    { roleName: 'Admin', username: 'admin1', password: 'S3cret-Admin!' },
    { roleName: 'Viewer', username: 'view1', password: 'S3cret-View!' },
  ],
};

test('nested secrets are encrypted at rest (AES), other fields untouched', () => {
  const stored = encryptConfigData(app);
  assert.equal(stored.appName, 'Shop');
  assert.equal(stored.roles[0].username, 'admin1');
  assert.match(stored.roles[0].password, /^__AES__/);
  assert.match(stored.roles[1].password, /^__AES__/);
  assert.deepEqual(decryptConfigData(stored), app);
});

test('transit-encrypted nested values from the browser are decrypted', () => {
  const body = { ...app, roles: app.roles.map((r) => ({ ...r, password: encryptField(r.password) })) };
  assert.deepEqual(decryptConfigData(body), app);
});

test('passwords are fully masked at any depth; tokens keep a hint', () => {
  const masked = maskConfigData(encryptConfigData({ ...app, apiToken: 'tok_1234567890' }));
  assert.equal(masked.roles[0].password, '••••••••');
  assert.equal(masked.roles[1].password, '••••••••');
  assert.equal(masked.apiToken, 'tok•••90');
  assert.ok(!JSON.stringify(masked).includes('S3cret'));
});

test('a masked value sent back on save keeps the stored secret', () => {
  const stored = decryptConfigData(encryptConfigData({ ...app, apiToken: 'tok_1234567890' }));
  const resent = maskConfigData(stored); // what the form loaded and sends back unchanged
  resent.roles[1].password = 'New-View-Pass!'; // the user changed only this one
  assert.ok(hasMaskedSecret(resent));
  const restored = restoreMaskedSecrets(resent, stored);
  assert.equal(restored.apiToken, 'tok_1234567890');
  assert.equal(restored.roles[0].password, 'S3cret-Admin!');
  assert.equal(restored.roles[1].password, 'New-View-Pass!');
});

test('restore matches list items by name, not position', () => {
  const stored = decryptConfigData(encryptConfigData(app));
  const resent = maskConfigData(stored);
  resent.roles.reverse(); // user reordered or removed a role
  const restored = restoreMaskedSecrets(resent, stored);
  assert.equal(restored.roles[0].roleName, 'Viewer');
  assert.equal(restored.roles[0].password, 'S3cret-View!');
});

test('a mask with nothing stored is dropped, never saved', () => {
  const restored = restoreMaskedSecrets({ apiToken: '•••••' }, {});
  assert.equal('apiToken' in restored, false);
});
