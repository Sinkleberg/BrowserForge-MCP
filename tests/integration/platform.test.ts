import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FlowBuilder, type Flow } from '@browserforge/flows';
import { startStack, waitFor, type Stack } from '../helpers/stack.js';
import { connectFake, type Fake } from '../helpers/fake-extension.js';

let stack: Stack;
let fake: Fake;
let baseHandler: (req: any) => unknown;
const requests: { action: string; args: any }[] = [];
type Handler = (req: any) => unknown;
/** What the pretend page answers to a table read; tests change it to play out a form, then a confirmation. */
let table: { url: string; title: string; rows: string[]; notes: string[] } = { url: 'https://shop.test/signup', title: 'Sign up', rows: [], notes: [] };

beforeAll(async () => {
  stack = await startStack();
  fake = await connectFake(stack.app.port, { id: 'br-platform', token: stack.app.ctx.config.extensionToken });
  const base: Handler = (req) => {
    requests.push({ action: req.action, args: req.args });
    switch (req.action) {
      case 'navigate': return { url: req.args.url ?? table.url, title: 'x' };
      case 'tabs_select': return { tabId: 1, url: 'https://shop.test/signup' };
      case 'interactive_elements': return table;
      case 'resolve_locator': return { ref: '1:7' };
      default: return {};
    }
  };
  baseHandler = base;
  fake.onRequest = base;
  await waitFor(() => stack.app.ctx.hub.listPeers().length > 0);
});
afterAll(async () => {
  fake?.close();
  await stack.close();
});

const flowOf = (steps: (b: FlowBuilder) => void): Flow => {
  const b = new FlowBuilder({ id: 'shop.test/pending', site: 'shop.test', now: new Date() });
  b.navigate('https://shop.test/signup');
  steps(b);
  return stack.app.ctx.flows.store(b.flow);
};
const fillEmail = (b: FlowBuilder) => b.add({ action: 'fill', locator: { label: 'Email', id: 'email' }, fieldLabel: 'Email', value: 'ada@example.com', url: 'https://shop.test/signup' });
const fillPw = (b: FlowBuilder) => b.add({ action: 'fill', locator: { label: 'Password' }, fieldLabel: 'Password', sensitive: true, value: 'hunter2-secret', url: 'https://shop.test/signup' });
const submit = (b: FlowBuilder) => b.add({ action: 'click', locator: { role: 'button', name: 'Sign up' }, consequential: true, url: 'https://shop.test/signup' });

describe('site knowledge', () => {
  it('tells an agent what is known when it opens the site, and nothing for an unknown one', async () => {
    const first = (await stack.call('browser_navigate', { url: 'https://shop.test/signup' })).data;
    expect(first.data.siteCard).toBeUndefined();
    const noted = (await stack.call('site_note', { site: 'https://shop.test/x', kind: 'needs_account', detail: 'create one with Google sign-in' })).data;
    expect(noted.saved).toBe(true);
    const again = (await stack.call('browser_navigate', { url: 'https://shop.test/signup' })).data;
    expect(again.data.siteCard).toMatch(/needs account: create one with Google sign-in/);
    expect((await stack.call('browser_select_tab', { tabId: 1 })).data.siteCard).toMatch(/needs account/);
    const info = (await stack.call('site_info', { site: 'shop.test' })).data.data;
    expect(info.visits).toBeGreaterThanOrEqual(2);
    expect((await stack.call('site_list')).data.sites.map((s: any) => s.host)).toContain('shop.test');
  });

  it('rejects a site name that is not a host', async () => {
    expect((await stack.call('site_note', { site: '../../etc', kind: 'note' })).isError).toBe(true);
  });

  it('learns about custom dropdowns and iframes from what agents do', async () => {
    fake.onRequest = (req) => (req.action === 'select_option'
      ? { selected: 'Italy', _flow: [{ locator: { role: 'combobox', name: 'Country' }, fieldLabel: 'Country', custom: true, pageUrl: 'https://shop.test/signup', frameUrl: 'https://forms.shop.test/f' }] }
      : baseHandler(req));
    await stack.call('browser_select_option', { ref: '1:2', label: 'Italy' });
    const card = stack.app.ctx.knowledge.sites.card('shop.test')!;
    expect(card).toMatch(/custom dropdown: Country/);
    expect(card).toMatch(/iframe form/);
  });
});

describe('verification', () => {
  it('browser_verify reads a confirmation as success and an error as failure', async () => {
    fake.onRequest = baseHandler;
    table = { url: 'https://shop.test/signup/thank-you', title: 'Thanks', rows: ['1 | a | Back to jobs | 1:1'], notes: ['Thank you, your application has been received'] };
    expect((await stack.call('browser_verify')).data.data.verdict).toBe('success');
    table = { url: 'https://shop.test/signup', title: 'Sign up', rows: ['1 | input:text (editable) [empty] | Email | 1:1'], notes: ['This field is required'] };
    const v = (await stack.call('browser_verify')).data.data;
    expect(v.verdict).toBe('failure');
    expect(v.signals.length).toBeGreaterThan(0);
  });

  it('judges a task by itself after a submit: outcome on the site and on the flow, with no agent involved', async () => {
    table = { url: 'https://shop.test/done', title: 'Thanks', rows: [], notes: ['Grazie, la tua candidatura è stata ricevuta'] };
    fake.onRequest = (req) => (req.action === 'interactive_elements' ? table : req.action === 'click' ? { _flow: [{ locator: { role: 'button', name: 'Submit' }, consequential: true, pageUrl: 'https://shop.test/apply' }] } : {});
    const before = stack.app.ctx.knowledge.sites.get('shop.test')!.outcomes.success;
    await stack.call('browser_click', { ref: '1:9' });
    await waitFor(() => stack.app.ctx.knowledge.sites.get('shop.test')!.outcomes.success > before, { what: 'automatic outcome', timeoutMs: 6000 });
    const flows = stack.app.ctx.flows.list('shop.test');
    expect(stack.app.ctx.flows.get(flows[0]!.id)!.outcome).toBe('success');
  });

  it('labels a finished goal run good by looking at the page, and the agent can still overrule it', async () => {
    const traces = stack.app.ctx.knowledge.traces;
    table = { url: 'https://shop.test/apply', title: 'Apply', rows: ['1 | input:text (editable) [empty] | Email | 1:1', '2 | button | Submit | 1:2'], notes: [] };
    fake.onRequest = (req) => {
      if (req.action === 'interactive_elements') return table;
      if (req.action === 'type') { return {}; }
      if (req.action === 'click') { table = { url: 'https://shop.test/apply/thank-you', title: 'Thanks', rows: [], notes: ['Thank you, we have received your application'] }; return {}; }
      return {};
    };
    stack.app.ctx.config.decider.mode = 'qwen';
    // Stand in for the local model so the test needs no Ollama.
    const { runGoal } = await import('../../apps/mcp-server/src/goal-runner.js');
    const script = [{ op: 'CLICK', target: 2, inputKey: null, confidence: 0.99 }, { op: 'DONE', target: null, inputKey: null, confidence: 0.99 }];
    const r = await runGoal(
      { call: (a, args, o) => stack.app.ctx.hub.call(a, args, { timeoutMs: o.timeoutMs }), decide: async () => ({ raw: script.shift(), source: 'qwen' as const }), traces, docs: stack.app.ctx.knowledge.docs, signal: new AbortController().signal, sleep: async () => undefined },
      { goal: 'Submit the application', inputs: {}, maxSteps: 4, minConfidence: 0.5 },
    );
    expect(r.stopReason).toBe('done');
    expect(r.verification.verdict).toBe('success');
    expect(traces.labelOf(r.runId)).toBe('good');
    expect(traces.labelBy(r.runId)).toBe('auto');
    traces.label(r.runId, 'bad', 'it was a duplicate', 'agent');
    expect(traces.labelOf(r.runId)).toBe('bad');
  });
});

describe('flow tasks', () => {
  it('brackets one task as a flow, lets browser_verify label it, and keeps the agent outcome final', async () => {
    fake.onRequest = (req) => {
      if (req.action === 'fill_field') return { filled: true, _flow: [{ locator: { tag: 'input', label: 'Email', css: '#e' }, fieldLabel: 'Email', pageUrl: 'https://task.test/apply', tabId: 1 }] };
      if (req.action === 'interactive_elements') return { url: 'https://task.test/apply', title: 'Apply', rows: [], notes: ['Thank you, we have received your application'] };
      return baseHandler(req);
    };
    try {
      const begin = (await stack.call('flow_task_begin', { name: 'Apply: Task Inc', tabId: 1, params: { email: 'ada@example.com' } })).data;
      expect(begin.taskId).toBeTruthy();
      await stack.call('browser_fill_field', { ref: '1:1', value: 'ada@example.com', tabId: 1 });
      expect((await stack.call('browser_verify', { tabId: 1 })).data.data.verdict).toBe('success');
      const end = (await stack.call('flow_task_end', { taskId: begin.taskId, outcome: 'dry_run', note: 'not submitted' })).data;
      expect(end.written).toBe(true);
      const f = stack.app.ctx.flows.get(end.flowId)!;
      expect(f).toMatchObject({ name: 'Apply: Task Inc', site: 'task.test', outcome: 'dry_run', outcomeBy: 'agent', task: { note: 'not submitted' } });
      expect(f.params[0]).toMatchObject({ name: 'email' });
      expect(f.params[0]!.default).toBeUndefined();
      expect(JSON.stringify(f)).not.toContain('ada@example.com');
      expect((await stack.call('flow_task_end', { taskId: begin.taskId, outcome: 'failure' })).data.error.message).toMatch(/No open task/);
    } finally {
      fake.onRequest = baseHandler;
    }
  });

  it('records how a replay went on the flow', async () => {
    const f = flowOf((b) => { fillEmail(b); submit(b); });
    const run = (await stack.call('flow_run', { id: f.id, params: { email: 'ada@example.com' } })).data;
    expect(typeof run.ok).toBe('boolean');
    expect(stack.app.ctx.flows.get(f.id)!.runs).toMatchObject({ count: 1 });
  });
});

describe('flow list and prune tools', () => {
  const store = (outcome: Flow['outcome'] | undefined, steps: (b: FlowBuilder) => void): Flow => {
    const b = new FlowBuilder({ id: 'listing.test/pending', site: 'listing.test', now: new Date() });
    b.navigate('https://listing.test/start');
    steps(b);
    return stack.app.ctx.flows.store({ ...b.flow, ...(outcome ? { outcome } : {}) });
  };
  it('filters by outcome, limits the answer, hints at merging, and only prunes when told to', async () => {
    for (let i = 0; i < 3; i++) store('success', (b) => { fillEmail(b); submit(b); });
    store('failure', (b) => { fillEmail(b); submit(b); });
    const browsing = store(undefined, () => undefined);
    const ok = (await stack.call('flow_list', { site: 'listing.test', outcome: 'success', limit: 2 })).data;
    expect(ok).toMatchObject({ total: 3, shown: 2 });
    expect(ok.flows.every((f: any) => f.outcome === 'success')).toBe(true);
    expect(ok.hints).toEqual(expect.arrayContaining([expect.objectContaining({ site: 'listing.test', count: 3, suggest: 'flow_consolidate' })]));
    expect((await stack.call('flow_list', { site: 'listing.test', outcome: 'unknown' })).data.total).toBe(1);

    const report = (await stack.call('flow_prune', { site: 'listing.test' })).data;
    expect(report).toMatchObject({ applied: false, delete: 1 });
    expect(report.note).toMatch(/apply/);
    expect(stack.app.ctx.flows.get(browsing.id)).toBeDefined();
    const done = (await stack.call('flow_prune', { site: 'listing.test', apply: true })).data;
    expect(done).toMatchObject({ applied: true, delete: 1 });
    expect(stack.app.ctx.flows.get(browsing.id)).toBeUndefined();
    expect((await stack.call('flow_list', { site: 'listing.test' })).data.total).toBe(4); // the four real tasks stay
  });
});

describe('flows to workflows', () => {
  it('merges recordings, turns the result into a skill, and runs it with the values you give', async () => {
    const one = flowOf((b) => { fillEmail(b); fillPw(b); submit(b); });
    const two = flowOf((b) => { fillEmail(b); fillPw(b); submit(b); });
    const merged = (await stack.call('flow_consolidate', { site: 'shop.test', ids: [one.id, two.id], name: 'Shop signup' })).data;
    expect(merged.fromFlows).toBe(2);
    expect(merged.params.find((p: any) => p.name === 'password').sensitive).toBe(true);
    const file = fs.readFileSync(path.join(stack.home, 'flows', `${merged.id}.json`), 'utf8');
    expect(file).not.toContain('hunter2-secret');
    expect(stack.app.ctx.flows.get(merged.id)).toMatchObject({ saved: true, name: 'Shop signup' });

    const made = (await stack.call('flow_to_skill', { id: merged.id, name: 'shop-signup', description: 'Sign up on the shop' })).data;
    expect(made.inputs).toEqual(expect.arrayContaining(['email', 'password']));
    const skillText = ['SKILL.md', 'workflows/run.json', 'flow.json'].map((f) => fs.readFileSync(path.join(made.dir, f), 'utf8')).join('\n');
    for (const secret of ['ada@example.com', 'hunter2-secret']) expect(skillText).not.toContain(secret);
    expect((await stack.call('flow_to_skill', { id: merged.id, name: 'shop-signup', description: 'Again' })).isError).toBe(true);
    expect((await stack.call('skill_list')).data.skills.map((s: any) => s.name)).toContain('shop-signup');

    requests.length = 0;
    fake.onRequest = (req) => {
      requests.push({ action: req.action, args: req.args });
      return req.action === 'resolve_locator' ? { ref: '1:7' } : req.action === 'navigate' ? { url: req.args.url } : {};
    };
    const ran = (await stack.call('skill_run_workflow', { skill: 'shop-signup', workflow: 'run', inputs: { email: 'new@example.com', password: 'pw-from-user' } })).data;
    const done = await waitFor(async () => { const s = (await stack.call('workflow_get_status', { workflowId: ran.workflowId })).data; return ['completed', 'failed'].includes(s.status) ? s : null; }, { what: 'replay', timeoutMs: 15_000 });
    expect(done.status).toBe('completed');
    const typed = requests.filter((r) => r.action === 'fill_field').map((r) => r.args.value);
    expect(typed).toEqual(['new@example.com', 'pw-from-user']);

    // On a computer that never recorded the flow, the skill brings its own value-free copy.
    stack.app.ctx.flows.delete(merged.id);
    requests.length = 0;
    const again = (await stack.call('skill_run_workflow', { skill: 'shop-signup', workflow: 'run', inputs: { email: 'other@example.com', password: 'pw-2' } })).data;
    const done2 = await waitFor(async () => { const s = (await stack.call('workflow_get_status', { workflowId: again.workflowId })).data; return ['completed', 'failed'].includes(s.status) ? s : null; }, { what: 'replay', timeoutMs: 15_000 });
    expect(done2.status).toBe('completed');
    expect(requests.filter((r) => r.action === 'fill_field').map((r) => r.args.value)).toEqual(['other@example.com', 'pw-2']);
    expect(stack.app.ctx.flows.get(merged.id)!.params.every((p) => p.default === undefined)).toBe(true);

    // A different local flow under the same id (ids are site + second, so another computer can have one) is not replayed in its place.
    const adopted = stack.app.ctx.flows.get(merged.id)!;
    stack.app.ctx.flows.delete(merged.id);
    stack.app.ctx.flows.adopt({ ...adopted, steps: adopted.steps.slice(0, 1) });
    requests.length = 0;
    const clash = await stack.call('skill_run_workflow', { skill: 'shop-signup', workflow: 'run', inputs: { email: 'x@example.com', password: 'pw-3' } });
    expect(clash.isError).toBe(true);
    expect(clash.data.error.message).toMatch(/different flow with the id/);
    expect(requests).toEqual([]);
  });

  it('refuses to merge a single recording or a missing id', async () => {
    expect((await stack.call('flow_consolidate', { site: 'nowhere.test', name: 'x' })).isError).toBe(true);
    expect((await stack.call('flow_to_skill', { id: 'shop.test/20200101T000000', name: 'ghost', description: 'does not exist' })).isError).toBe(true);
  });
});
