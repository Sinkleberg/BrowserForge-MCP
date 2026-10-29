import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchChromium, launchFirefox, type BrowserHandle } from '../helpers/browsers.js';
import { startStack, type Stack } from '../helpers/stack.js';
import { deciderStatus } from '../../apps/mcp-server/src/decider.js';

const kinds = (process.env.BF_BROWSERS ?? 'firefox,chromium').split(',') as ('firefox' | 'chromium')[];
const model = process.env.BF_DECIDER_MODEL ?? 'qwen3:4b-instruct';
const status = await deciderStatus({ url: 'http://127.0.0.1:11434', model, minConfidence: 0.7, timeoutMs: 1000 });
const available = status.reachable && status.modelPulled;

// Runs the REAL local model; skipped when Ollama or the model is not available.
describe.skipIf(!available).each(kinds)('browser_run_goal with a local model — %s', (kind) => {
  let stack: Stack;
  let browser: BrowserHandle;
  beforeAll(async () => {
    // A cold model needs 20-60 s to load into memory; do it up front so the test measures decisions, not loading.
    await fetch('http://127.0.0.1:11434/api/chat', { method: 'POST', body: JSON.stringify({ model, stream: false, keep_alive: '10m', messages: [{ role: 'user', content: 'ok' }], options: { num_predict: 1 } }), signal: AbortSignal.timeout(170_000) });
    stack = await startStack();
    stack.app.ctx.config.decider.model = model;
    stack.app.ctx.config.decider.timeoutMs = 120_000;
    browser = kind === 'firefox' ? await launchFirefox(stack.app) : await launchChromium(stack.app);
    await browser.openPage(stack.demo.url + '/signup');
  });
  afterAll(async () => {
    await browser?.close();
    await stack?.close();
  });

  it('fills the form with the provided values, leaves the submit click to the human, then remembers the run', async () => {
    const run = stack.call('browser_run_goal', {
      goal: 'Fill in the signup form and submit it',
      inputs: { 'first name': 'Ada', 'last name': 'Lovelace', 'birth month': 'July' },
      maxSteps: 8,
    });
    // The Submit click is consequential: the run must stop at the approval prompt, not submit by itself.
    const first = await Promise.race([browser.decideApproval(true), run.then((r) => new Error('run ended before any approval: ' + JSON.stringify(r.data?.data ?? r.data, null, 1)))]);
    if (first instanceof Error) throw first;
    expect(first).toMatch(/submit/i);
    const r = await run;
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    const out = r.data.data;
    expect(['done', 'blocked', 'max_steps', 'no_progress']).toContain(out.stopReason);
    const submitted = await browser.evalInPage<{ first: string; last: string; month: string } | null>('return window.__submitted');
    expect(submitted).toEqual({ first: 'Ada', last: 'Lovelace', month: 'July' });
    expect(out.steps.length).toBeGreaterThanOrEqual(4);
    // Values never reach traces.
    expect(JSON.stringify(stack.app.ctx.knowledge.traces.exportDataset((s) => ({ system: '', user: JSON.stringify(s), assistant: '' }), 'any'))).not.toContain('Lovelace');
    expect((await stack.call('browser_goal_feedback', { runId: out.runId, outcome: 'good' })).data.labelled).toBe(true);
  });

  it('after the same situation succeeded three times it takes the remembered steps without calling the model (approval still required)', async () => {
    const once = async () => {
      await stack.call('browser_navigate', { url: stack.demo.url + '/signup' });
      const run = stack.call('browser_run_goal', { goal: 'Fill in the signup form and submit it', inputs: { 'first name': 'Ada', 'last name': 'Lovelace', 'birth month': 'July' }, maxSteps: 8 });
      const first = await Promise.race([browser.decideApproval(true), run.then((r) => new Error('run ended early: ' + JSON.stringify(r.data?.data ?? r.data)))]);
      if (first instanceof Error) throw first;
      const r = await run;
      expect(r.isError).toBe(false);
      return r.data.data as { steps: { source: string }[]; stats: { modelCalls: number; memoryHits: number } };
    };
    // The previous test already produced one successful run on this page; two more make three, so the next one can use memory.
    await once(); await once();
    const fourth = await once();
    expect(fourth.stats.memoryHits).toBeGreaterThan(0);
    expect(fourth.steps.some((s) => s.source === 'memory')).toBe(true);
    expect(fourth.stats.modelCalls).toBeLessThan(fourth.steps.length + 1);
    expect(await browser.evalInPage<{ month: string }>('return window.__submitted')).toMatchObject({ month: 'July' });
  });
});
