import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { humanRunId } from '../../apps/mcp-server/src/flows/human.js';
import { renderTraceForTraining } from '../../apps/mcp-server/src/goal-runner.js';
import { launchChromium, launchFirefox, type BrowserHandle } from '../helpers/browsers.js';
import { startStack, waitFor, type Stack } from '../helpers/stack.js';

const kinds = (process.env.BF_BROWSERS ?? 'firefox,chromium').split(',') as ('firefox' | 'chromium')[];

/** Every file under the server's config folder, as text: what "nothing sensitive is stored" has to be true of. */
function everythingOnDisk(dir: string): string {
  let all = '';
  for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) {
    const p = path.join(dir, f);
    try {
      if (fs.statSync(p).isFile()) all += fs.readFileSync(p, 'utf8') + '\n';
    } catch {
      /* gone */
    }
  }
  return all;
}

describe.each(kinds)('Record me: the person\'s own actions — %s', (kind) => {
  let stack: Stack;
  let browser: BrowserHandle;
  beforeAll(async () => {
    stack = await startStack();
    browser = kind === 'firefox' ? await launchFirefox(stack.app) : await launchChromium(stack.app);
    await browser.openPage(stack.demo.url + '/signup');
  });
  afterAll(async () => {
    await browser?.close();
    await stack?.close();
  });

  const humanFlow = () => {
    const f = stack.app.ctx.flows.list().map((x) => stack.app.ctx.flows.get(x.id)!).find((x) => x.source === 'human');
    return f;
  };
  const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

  it('records nothing until the person turns it on', async () => {
    await browser.userFill('#first', 'Nobody');
    await browser.userClick('#last');
    await settle();
    expect(humanFlow()).toBeUndefined();
    expect(stack.app.ctx.knowledge.traces.stats().byDecider.human).toBeUndefined();
  });

  it('turns what the person does into a flow, training examples, a site lesson and an automatic verdict', async () => {
    await browser.popupMessage('setRecord', { on: true, values: true, task: 'Sign up on the demo shop' });
    await browser.openPage(stack.demo.url + '/signup'); // a fresh page loads with recording already on
    await settle(900);
    await browser.userFill('#first', 'Ada');
    await browser.userFill('#last', 'Lovelace');
    await browser.userPickLast('#mon');
    await browser.userClick('#go');
    await waitFor(() => humanFlow()?.steps.some((s) => s.action === 'click' && s.consequential), { what: 'the submit to be recorded', timeoutMs: 15_000 });

    const flow = humanFlow()!;
    expect(flow.source).toBe('human');
    expect(flow.steps.map((s) => s.action)).toEqual(['navigate', 'fill', 'fill', 'select', 'click']);
    expect(flow.params.map((p) => [p.name, p.default])).toEqual([['first_name', 'Ada'], ['last_name', 'Lovelace'], ['birth_month', 'December']]);

    // Training examples: the page's rows before each step, the step the person took, the goal they stated.
    const traces = stack.app.ctx.knowledge.traces;
    await waitFor(() => (traces.stats().byDecider.human?.steps ?? 0) >= 4, { what: 'training steps' });
    const lines = traces.exportDataset(renderTraceForTraining, 'any');
    const human = lines.map((l) => JSON.parse(l).messages as { role: string; content: string }[]).filter((m) => m[1]!.content.includes('Sign up on the demo shop'));
    expect(human.length).toBeGreaterThanOrEqual(4);
    expect(JSON.parse(human[0]![2]!.content)).toMatchObject({ op: 'TYPE', inputKey: 'first_name' });
    expect(human[0]![1]!.content).toMatch(/First name/);

    // The site learned from it, and the page was judged finished without anyone asking.
    await waitFor(() => stack.app.ctx.flows.get(flow.id)?.outcome === 'success', { what: 'automatic verdict', timeoutMs: 10_000 });
    await waitFor(() => traces.labelOf(humanRunId(flow.id)) === 'good', { what: 'the run to be labelled good', timeoutMs: 5000 });
    expect(traces.labelBy(humanRunId(flow.id))).toBe('auto');
    expect(stack.app.ctx.knowledge.sites.list().length).toBeGreaterThan(0);
    expect(stack.demo.signups.at(-1)).toMatchObject({ first: 'Ada', last: 'Lovelace', month: 'December' });
  });

  it('shows REC in the popup and keeps agents out of the person\'s recording', async () => {
    const state = await browser.popupMessage('getState');
    expect(state.state.recordHuman).toBe(true);
    const before = humanFlow()!.steps.length;
    // An agent acting through BrowserForge produces synthetic events, which are never taken for the person.
    await stack.call('browser_navigate', { url: stack.demo.url + '/signup' });
    const t = (await stack.call('browser_get_interactive_elements', { format: 'table' })).data.data.rows as string[];
    await stack.call('browser_type', { ref: t.find((r) => /First name/.test(r))!.split(' | ')[3]!, text: 'AgentTyped' });
    await settle();
    expect(humanFlow()!.steps.length).toBe(before);
    expect(everythingOnDisk(path.join(stack.home, 'flows')).split('"source": "human"').length).toBeLessThanOrEqual(2);
  });

  it('never records a password, whatever the switches say', async () => {
    await browser.evalInPage(`var i=document.createElement('input');i.type='password';i.id='pw';i.setAttribute('aria-label','Password');document.body.appendChild(i);var c=document.createElement('input');c.id='cc';c.name='card-number';c.autocomplete='cc-number';document.body.appendChild(c);return 1`);
    await browser.userFill('#pw', 'hunter2-TOPSECRET');
    await browser.userFill('#cc', '4242424242424242');
    await browser.userClick('#first'); // leaving the field is what saves it
    await settle(900);
    const disk = everythingOnDisk(stack.home);
    expect(disk).not.toContain('hunter2-TOPSECRET');
    expect(disk).not.toContain('4242424242424242');
    // The step itself is noted (so a replay knows a password goes here) but without any value.
    const pw = humanFlow()!.params.find((p) => p.name === 'password');
    if (pw) expect(pw).toMatchObject({ sensitive: true });
  });

  it('stops when the person turns it off', async () => {
    await browser.popupMessage('setRecord', { on: false });
    await settle(700);
    const before = humanFlow()!.steps.length;
    await browser.userFill('#last', 'After');
    await browser.userClick('#first');
    await settle();
    expect(humanFlow()!.steps.length).toBe(before);
    expect((await browser.popupMessage('getState')).state.recordHuman).toBe(false);
  });
});
