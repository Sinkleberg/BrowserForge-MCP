import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserForgeError } from '@browserforge/shared';
import { DocStore, TraceStore } from '@browserforge/knowledge';
import { buildUserPrompt, decisionSchema, parseRows, runGoal, type GoalDeps, type Decision } from '../../apps/mcp-server/src/goal-runner.js';
import { assertLoopbackUrl } from '../../apps/mcp-server/src/context.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-goal-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const PAGE = ['1 | input:text (editable) | First name | r:1', '2 | combobox | Select Month | r:2', '3 | button | Send | r:3'];

/** A fake browser: serves the same table, records actions, optionally flips the table after an action. */
function harness(decisions: Partial<Decision>[], opts: { afterAction?: () => string[]; failWith?: BrowserForgeError } = {}) {
  let rows = PAGE;
  const actions: { action: string; args: any }[] = [];
  const prompts: string[] = [];
  const schemas: any[] = [];
  let i = 0;
  const deps: GoalDeps = {
    call: async (action, args) => {
      if (action === 'interactive_elements') return { url: 'https://example.com/signup/12345', rows };
      actions.push({ action, args });
      if (opts.failWith) throw opts.failWith;
      if (opts.afterAction) rows = opts.afterAction();
      return {};
    },
    decide: async (_s, user, schema) => { prompts.push(user); schemas.push(schema); const d = decisions[Math.min(i++, decisions.length - 1)]!; return { op: 'DONE', target: null, inputKey: null, confidence: 0.95, ...d }; },
    traces: new TraceStore(dir), docs: new DocStore(dir), signal: new AbortController().signal, sleep: async () => undefined,
  };
  return { deps, actions, prompts, schemas };
}
const args = (over: object = {}) => ({ goal: 'Sign up', inputs: { 'first name': 'Ada-SECRET', 'birth month': 'July' }, maxSteps: 6, minConfidence: 0.7, ...over });

describe('browser_run_goal loop', () => {
  it('runs steps through the normal actions, types only provided values, and stops on DONE', async () => {
    const h = harness([{ op: 'TYPE', target: 1, inputKey: 'first name' }, { op: 'SELECT', target: 2, inputKey: 'birth month' }, { op: 'DONE' }], { afterAction: (() => { let n = 0; return () => [...PAGE, `${4 + ++n} | link | extra${n} | r:${9 + n}`]; })() });
    const r = await runGoal(h.deps, args());
    expect(r.stopReason).toBe('done');
    expect(h.actions.map((a) => a.action)).toEqual(['type', 'select_option']);
    expect(h.actions[0]!.args).toMatchObject({ ref: 'r:1', text: 'Ada-SECRET', clear: true });
    expect(h.actions[1]!.args).toMatchObject({ ref: 'r:2', label: 'July' });
  });

  it('never shows input values to the model or writes them to traces', async () => {
    const h = harness([{ op: 'TYPE', target: 1, inputKey: 'first name' }, { op: 'DONE' }], { afterAction: () => [...PAGE, '4 | link | extra | r:4'] });
    await runGoal(h.deps, args());
    expect(h.prompts.join('\n')).not.toContain('Ada-SECRET');
    expect(h.prompts[0]).toContain('first name');
    expect(fs.readFileSync(path.join(dir, 'traces.jsonl'), 'utf8')).not.toContain('Ada-SECRET');
  });

  it('constrains the model to the real rows and the given input keys', () => {
    const s: any = decisionSchema(3, ['a', 'b']);
    expect(s.properties.target.enum).toEqual([1, 2, 3, null]);
    expect(s.properties.inputKey.enum).toEqual(['a', 'b', null]);
    expect(s.properties.op.enum).not.toContain('NAVIGATE');
  });

  it.each([
    ['low confidence', [{ op: 'CLICK', target: 3, confidence: 0.4 }], 'low_confidence'],
    ['typing into a button', [{ op: 'TYPE', target: 3, inputKey: 'first name' }], 'invalid_decision'],
    ['an input key that was not provided', [{ op: 'TYPE', target: 1, inputKey: 'ssn' }], 'invalid_decision'],
    ['a row that does not exist', [{ op: 'CLICK', target: 99 }], 'invalid_decision'],
    ['selecting on a plain text field', [{ op: 'SELECT', target: 1, inputKey: 'birth month' }], 'invalid_decision'],
    ['blocked', [{ op: 'BLOCKED' }], 'blocked'],
  ])('stops on %s without acting', async (_n, decisions, reason) => {
    const h = harness(decisions as Partial<Decision>[]);
    expect((await runGoal(h.deps, args())).stopReason).toBe(reason);
    expect(h.actions).toEqual([]);
  });

  it('gives a small model one retry with the reason when its first pick is impossible', async () => {
    const h = harness([{ op: 'TYPE', target: 3, inputKey: 'first name' }, { op: 'TYPE', target: 1, inputKey: 'first name' }, { op: 'DONE' }], { afterAction: () => [...PAGE, '4 | link | x | r:4'] });
    const r = await runGoal(h.deps, args());
    expect(r.stopReason).toBe('done');
    expect(h.prompts[1]).toContain('was not possible');
    expect(h.actions).toHaveLength(1);
    expect(h.actions[0]!.args.ref).toBe('r:1');
  });

  it('stops when the same step changes nothing, and at maxSteps', async () => {
    const same = harness([{ op: 'CLICK', target: 3 }]);
    expect((await runGoal(same.deps, args())).stopReason).toBe('no_progress');
    let n = 0;
    const moving = harness([{ op: 'SCROLL_DOWN' }], { afterAction: () => [...PAGE, `${4 + ++n} | link | x${n} | r:${n}`] });
    const r = await runGoal(moving.deps, args({ maxSteps: 3 }));
    expect(r.stopReason).toBe('max_steps');
    expect(r.steps).toHaveLength(3);
  });

  it('stops when the human denies an approval', async () => {
    const h = harness([{ op: 'CLICK', target: 3 }], { failWith: new BrowserForgeError('APPROVAL_DENIED', 'The human denied this action') });
    const r = await runGoal(h.deps, args());
    expect(r.stopReason).toBe('approval_denied');
    expect(h.actions).toHaveLength(1);
  });

  it('reports an unreachable decider instead of throwing', async () => {
    const h = harness([]);
    h.deps.decide = async () => { throw new Error('Cannot reach the local model server'); };
    const r = await runGoal(h.deps, args());
    expect(r.stopReason).toBe('decider_unavailable');
    expect(r.steps[0]!.error).toMatch(/Cannot reach/);
  });

  it('skips the model after the same situation succeeded three times, and feeds document notes to the model', async () => {
    for (const run of ['a', 'b', 'c']) {
      const h = harness([{ op: 'CLICK', target: 3 }, { op: 'DONE' }], { afterAction: () => [...PAGE, '4 | link | thanks | r:4'] });
      h.deps.traces = new TraceStore(dir); h.deps.docs = new DocStore(dir);
      await runGoal(h.deps, args());
      void run;
    }
    const h = harness([{ op: 'DONE' }], { afterAction: () => [...PAGE, '4 | link | thanks | r:4'] });
    h.deps.traces = new TraceStore(dir); h.deps.docs = new DocStore(dir);
    const r = await runGoal(h.deps, args());
    expect(r.steps[0]).toMatchObject({ op: 'CLICK', source: 'memory' });
    expect(r.stats.memoryHits).toBeGreaterThan(0);

    fs.writeFileSync(path.join(dir, 'cv.txt'), 'Sign up tip: use the work email for the account.');
    const docs = new DocStore(dir); docs.add(path.join(dir, 'cv.txt'));
    const g = harness([{ op: 'DONE' }]); g.deps.docs = docs; g.deps.traces = new TraceStore(path.join(dir, 'empty'));
    await runGoal(g.deps, args());
    expect(g.prompts[0]).toContain('use the work email');
  });
});

describe('helpers', () => {
  it('parses rows including empty labels', () => {
    expect(parseRows(['5 | button |  | r:5', '6 | input:text (editable) (disabled) | Name | r:6'])).toMatchObject([{ n: 5, label: '', ref: 'r:5' }, { n: 6, editable: true, disabled: true, kind: 'input:text' }]);
    expect(buildUserPrompt({ goal: 'g', inputKeys: [], host: 'h', path: '/p', table: [], recent: [] })).toContain('(none visible)');
  });
  it('only accepts a decider on this machine', () => {
    expect(assertLoopbackUrl('http://localhost:11434')).toBe('http://localhost:11434');
    expect(() => assertLoopbackUrl('http://192.168.1.5:11434')).toThrow(/this machine/);
    expect(() => assertLoopbackUrl('https://api.example.com')).toThrow(/this machine/);
  });
});
