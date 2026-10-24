/**
 * Unit tests for application environments (services/app-environments.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appEnvironments, pickEnvironment, decryptRoles } from '../src/services/app-environments.js';
import { encryptConfigData } from '../src/utils/crypto.js';

process.env.ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');

const multi = {
  appName: 'Shop',
  environments: [
    { id: 'qa', name: 'QA', baseUrl: 'https://qa.shop.test', roles: [{ roleName: 'Admin', username: 'qa.admin', password: 'p1' }] },
    { id: 'uat', name: 'UAT', baseUrl: 'https://uat.shop.test', roles: [] },
    { id: 'dev', name: 'Dev', baseUrl: '' },
  ],
};

test('apps saved before environments read as one "default" environment', () => {
  const envs = appEnvironments({ appName: 'Old', baseUrl: ' https://old.test ', environment: 'staging', roles: [{ username: 'u', password: 'x' }] });
  assert.equal(envs.length, 1);
  assert.deepEqual(envs[0], { id: 'default', name: 'staging', baseUrl: 'https://old.test', roles: [{ roleName: 'user', username: 'u', password: 'x' }] });
});

test('multi-environment apps list every environment', () => {
  assert.deepEqual(appEnvironments(multi).map((e) => e.id), ['qa', 'uat', 'dev']);
});

test('pickEnvironment returns the requested environment, else the first with a URL', () => {
  assert.equal(pickEnvironment(multi, 'uat')?.baseUrl, 'https://uat.shop.test');
  assert.equal(pickEnvironment(multi)?.id, 'qa');
});

test('pickEnvironment never swaps to another environment for an unknown or URL-less id', () => {
  assert.equal(pickEnvironment(multi, 'prod'), undefined);
  assert.equal(pickEnvironment(multi, 'dev'), undefined);
});

test('decryptRoles returns plain passwords from stored (encrypted) roles', () => {
  const stored = encryptConfigData(multi) as typeof multi;
  const env = pickEnvironment(stored, 'qa')!;
  assert.match(env.roles[0].password, /^__AES__/);
  assert.equal(decryptRoles(env.roles)[0].password, 'p1');
});
