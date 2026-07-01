const EXPECT_RE = /\bexpect\s*\(/g;
const SOFT_RE = /\bexpect\s*\.\s*soft\s*\(/;
const NOT_RE = /\.\s*not\s*\./g;
const IF_FALSE_RE = /\bif\s*\(\s*false\s*\)/;
const TRY_EXPECT_RE = /\btry\s*\{[\s\S]*?\bexpect\s*\(/;
const TRIVIAL_RE = /\bexpect\s*\(\s*(?:true|false|1|0|!!1)\s*\)\s*\.\s*(?:toBeTruthy|toBeFalsy|toBe|toBeDefined)\b/;
const MATCH_ALL_TOKENS = ['/.*/', '/^.*$/', '[\s\S]*'];

function count(re, s) {
  return (s.match(re) || []).length;
}

function stripStringsAndComments(src) {
  return src
    .replace(/`(?:\[\s\S]|[^`\])*`/g, '``')
    .replace(/"(?:\.|[^"\\n])*"/g, '""')
    .replace(/'(?:\.|[^'\\n])*'/g, "''")
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

function hasMatchAll(live) {
  const compact = live.replace(/\s+/g, '');
  return MATCH_ALL_TOKENS.some((t) => compact.includes(t.replace(/\s+/g, '')));
}

console.log('=== CASE 1: Legitimate navigation retry ===');
const navRetry = `
try {
  await page.goto(url);
} catch (e) {
  await page.goto(url);
}
await expect(btn).toBeVisible();
`;
const live1 = stripStringsAndComments(navRetry);
console.log('Has try/expect:', TRY_EXPECT_RE.test(live1), '(ISSUE: legit retry rejected)');

console.log('\n=== CASE 2: Selector refinement reduces .not ===');
const origNeg = 'await expect(page).not.toHaveURL(/error/); await expect(page).not.toHaveURL(/login/);';
const fixedPos = 'await expect(page).toHaveURL(/dashboard/);';
console.log('Would reject:', count(NOT_RE, fixedPos) < count(NOT_RE, origNeg), '(ISSUE: legit refactor rejected)');

console.log('\n=== CASE 3: Soft assertions for robustness ===');
const origStrict = 'await expect(result).toBe("ok");';
const fixedSoft = 'await expect.soft(result).toBe("ok");';
const hasOrig = SOFT_RE.test(origStrict);
const hasNew = SOFT_RE.test(fixedSoft);
console.log('Would reject:', hasNew && !hasOrig, '(ISSUE: soft for robustness rejected)');

console.log('\n=== CASE 4: if(false) correctly caught ===');
const ifFalse = 'if (false) { await expect(x).toBe(1); }';
console.log('Detected if(false):', IF_FALSE_RE.test(ifFalse), '(GOOD)');

console.log('\n=== CASE 5: Trivial true correctly caught ===');
console.log('Detected trivial:', TRIVIAL_RE.test('await expect(true).toBeTruthy();'), '(GOOD)');

console.log('\n=== CASE 6: Escape sequence bypass of if(false) ===');
const ifFalseEscaped = 'if ( false ) { await expect(x).toBe(1); }';
console.log('Extra spaces bypass if(false):', !IF_FALSE_RE.test(ifFalseEscaped), '(BYPASS FOUND)');
