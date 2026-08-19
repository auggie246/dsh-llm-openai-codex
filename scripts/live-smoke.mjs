#!/usr/bin/env node
/**
 * Live end-to-end smoke test against the real Codex backend.
 *
 * Uses your actual ChatGPT subscription credentials (`~/.codex/auth.json`,
 * refreshing them if needed) and spends a handful of tokens on one tiny
 * streaming request through the same code path a dsh session uses:
 *
 *   node scripts/live-smoke.mjs [model]
 *
 * Default model: gpt-5.4-mini. Not part of `npm test` — run it deliberately.
 */
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolveRoute } from '../lib/index.js';
import { createCodexAuth } from '../lib/auth.js';

const model = process.argv[2] ?? 'gpt-5.4-mini';

console.log(`[smoke] resolving route and credentials...`);
const { profiles, route, authPath, refreshMarginMs } = resolveRoute({});
console.log(`[smoke] route "${route}" serves: ${profiles.get(route).piProvider.getModels().map((m) => m.id).join(', ')}`);
const auth = createCodexAuth({ path: authPath, refreshMarginMs });
console.log(`[smoke] credentials: ${auth.path} (account ${(await auth.current()).accountId ?? 'unknown'})`);

const adapter = new PiAiAdapter({
  profiles: () => profiles,
  resolveApiKey: () => auth.getAccessToken(),
  resolveAttachments: () => undefined,
  onReplayDegrade: (detail) => console.log('[smoke] replay degrade:', detail),
});

console.log(`[smoke] streaming ${model}: "Reply with exactly: pong"`);
let text = '';
let usage;
for await (const chunk of adapter.stream({
  provider: route,
  model,
  messages: [createUserMessage({ content: [{ type: 'text', text: 'Reply with exactly: pong' }] })],
  maxTokens: 64,
})) {
  if (chunk.type === 'text-delta') {
    text += chunk.text ?? '';
  } else if (chunk.type === 'usage') {
    usage = chunk.usage;
  } else if (chunk.type === 'finish') {
    console.log(`[smoke] finish reason: ${chunk.reason}`);
  }
}
console.log(`[smoke] response text: ${JSON.stringify(text)}`);
if (usage) console.log(`[smoke] usage: ${JSON.stringify(usage)}`);
if (!/pong/i.test(text)) {
  console.error('[smoke] FAIL: unexpected response text');
  process.exit(1);
}
console.log('[smoke] PASS — the ChatGPT subscription route works end to end.');
