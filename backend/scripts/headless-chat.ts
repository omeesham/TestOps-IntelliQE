/**
 * Headless smoke test for the chat module's generation flow.
 *
 * Mirrors exactly what POST /api/generate does after auth:
 *   1. hydrateAnthropicEnv()  → load the key configured in LLM Configuration
 *   2. runGenerationOnly()    → requirement → audit+planner → generator
 *   3. assert real test cases were produced (not the template fallback)
 *
 * No HTTP / auth / SSE needed — this drives the same in-process pipeline the
 * route invokes. Exits 0 on success, non-zero on failure, so it can be looped.
 *
 *   npx tsx --env-file=.env scripts/headless-chat.ts
 */
import { hydrateAnthropicEnv, describeResolved } from '../src/services/llm-config.service.js';
import { runGenerationOnly } from '../src/agents/pipeline.js';

const SAMPLE_REQUIREMENTS = `
User Login feature for an online banking portal.
- Registered users log in with email + password.
- After 5 failed attempts the account locks for 15 minutes.
- "Remember me" keeps the session for 30 days.
- Passwords must be at least 12 chars with one number and one symbol.
- Admins can reset any user's password from the admin console.
`.trim();

async function main() {
  const t0 = Date.now();

  // 1. Load the configured Anthropic key (no env key in .env — must come from DB).
  const resolved = await hydrateAnthropicEnv(null);
  console.log(`[headless] AI config: ${describeResolved(resolved)}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[headless] FAIL — no Anthropic key resolved from LLM Configuration.');
    process.exit(2);
  }

  // 2. Run the generation pipeline exactly as the chat route does.
  let lastTs = Date.now();
  const state = await runGenerationOnly(SAMPLE_REQUIREMENTS, {
    maxTestCases: 6,
    onProgress: (stage, status, detail) => {
      const elapsed = ((Date.now() - lastTs) / 1000).toFixed(1);
      lastTs = Date.now();
      console.log(`[headless]   +${elapsed}s  ${stage} ${status} — ${detail}`);
    },
  });

  const ms = Date.now() - t0;
  const cases = state.testCases || [];
  console.log(`\n[headless] features: ${(state.parsedRequirements?.features || []).join(', ') || '(none)'}`);
  console.log(`[headless] test cases generated: ${cases.length} in ${(ms / 1000).toFixed(1)}s`);
  for (const tc of cases.slice(0, 5)) {
    console.log(`   • [${tc.priority}/${tc.type}] ${tc.title || tc.scenario}`);
  }

  // 3. Assert. A real AI run yields several, varied, well-formed cases.
  if (cases.length < 3) {
    console.error(`[headless] FAIL — expected >= 3 test cases, got ${cases.length}.`);
    process.exit(3);
  }
  const haveSteps = cases.every((c) => Array.isArray(c.steps) && c.steps.length > 0);
  if (!haveSteps) {
    console.error('[headless] FAIL — some test cases have no steps.');
    process.exit(4);
  }

  console.log('\n[headless] PASS ✅');
  process.exit(0);
}

main().catch((e) => {
  console.error('[headless] ERROR:', e?.message || e);
  process.exit(1);
});
