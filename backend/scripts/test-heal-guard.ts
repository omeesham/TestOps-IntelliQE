/**
 * Unit test for the auto-healer anti-cheat guard (pure functions, no deps).
 *   npx tsx scripts/test-heal-guard.ts
 */
import { detectAssertionWeakening, isNoOpFix } from '../src/agents/heal-guard.js';

const HARD = `import { test, expect } from '@playwright/test';
test('login fails', async ({ page }) => {
  await page.goto('https://app.example.com/login');
  await page.getByPlaceholder('Username').fill('x');
  await page.getByPlaceholder('Password').fill('y');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).not.toHaveURL(/dashboard/);
  await expect(page.getByText('Invalid credentials')).toBeVisible();
});`;

interface Case { name: string; fixed: string; expectWeak: boolean }

const cases: Case[] = [
  { name: 'deleted an assertion', expectWeak: true,
    fixed: HARD.replace("  await expect(page.getByText('Invalid credentials')).toBeVisible();\n", '') },
  { name: 'replaced hard expect with expect.soft', expectWeak: true,
    fixed: HARD.replace('await expect(page.getByText', 'await expect.soft(page.getByText') },
  { name: 'introduced test.skip', expectWeak: true,
    fixed: HARD.replace("test('login fails'", "test.skip('login fails'") },
  { name: 'wrapped assertion in empty catch', expectWeak: true,
    fixed: HARD.replace('  await expect(page).not.toHaveURL(/dashboard/);',
      '  try { await expect(page).not.toHaveURL(/dashboard/); } catch {}') },
  { name: 'if(false) dead branch', expectWeak: true,
    fixed: HARD.replace('  await expect(page.getByText',
      '  if (false) await expect(page.getByText') },
  { name: 'match-all regex weakening', expectWeak: true,
    fixed: HARD.replace('.not.toHaveURL(/dashboard/)', '.toHaveURL(/.*/)') },
  { name: 'removed negative assertion (inversion)', expectWeak: true,
    fixed: HARD.replace('.not.toHaveURL(/dashboard/)', '.toHaveURL(/dashboard/)') },
  { name: 'trivially-true assertion', expectWeak: true,
    fixed: HARD.replace('await expect(page.getByText(\'Invalid credentials\')).toBeVisible();',
      'await expect(true).toBeTruthy();') },
  // ----- legitimate fixes that must NOT be flagged -----
  { name: 'legit: changed a selector, same assertions', expectWeak: false,
    fixed: HARD.replace("getByPlaceholder('Username')", "getByLabel('Username')") },
  { name: 'legit: goto-retry with NON-empty catch', expectWeak: false,
    fixed: HARD.replace("await page.goto('https://app.example.com/login');",
      "for (let i=0;i<3;i++){ try { await page.goto('https://app.example.com/login'); break; } catch { await page.waitForTimeout(500); } }") },
  { name: 'legit: added a soft check alongside unchanged hard ones', expectWeak: false,
    fixed: HARD.replace('await expect(page.getByText(\'Invalid credentials\')).toBeVisible();',
      "await expect(page.getByText('Invalid credentials')).toBeVisible();\n  await expect.soft(page.getByRole('alert')).toBeVisible();") },
];

let failures = 0;
for (const c of cases) {
  const v = detectAssertionWeakening(HARD, c.fixed);
  const ok = v.weakened === c.expectWeak;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  -> weakened=${v.weakened}${v.reasons.length ? ` [${v.reasons.join('; ')}]` : ''}`);
}

// no-op detection
const noop = isNoOpFix(HARD, HARD + '\n');
console.log(`${noop ? 'PASS' : 'FAIL'}  no-op fix detected -> ${noop}`);
if (!noop) failures++;

console.log(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILED`} (${cases.length + 1} cases)`);
process.exit(failures === 0 ? 0 : 1);
