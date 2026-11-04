import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findChromium, launchChromium, launchFirefox, type BrowserHandle } from '../helpers/browsers.js';
import { startStack, waitFor, type Stack } from '../helpers/stack.js';

const kinds = (process.env.BF_BROWSERS ?? 'firefox,chromium').split(',') as ('firefox' | 'chromium')[];
const ROOT = path.resolve(import.meta.dirname, '../..');
// Async on purpose: the demo site lives in this process, so a blocking exec would stop it answering the script's page loads.
const execAsync = promisify(execFile);

describe.each(kinds)('flows: record, replay and export — %s', (kind) => {
  let stack: Stack;
  let browser: BrowserHandle;
  let scratch: string;
  beforeAll(async () => {
    stack = await startStack();
    browser = kind === 'firefox' ? await launchFirefox(stack.app) : await launchChromium(stack.app);
    await browser.openPage(stack.demo.url + '/');
    // Inside node_modules so the exported scripts resolve the repo's own `playwright`.
    scratch = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-flows-'));
  });
  afterAll(async () => {
    await browser?.close();
    await stack?.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const ok = async (n: string, a: Record<string, unknown> = {}) => {
    if (process.env.BF_DEBUG) console.log('CALL', n, JSON.stringify(a).slice(0, 80));
    const r = await stack.call(n, a);
    expect(r.isError, `${n}: ${JSON.stringify(r.data)}`).toBe(false);
    return r.data;
  };
  const inner = (d: any) => d.data ?? d;
  const flows = async (): Promise<any[]> => (await ok('flow_list')).flows;

  it('records the signup as a flow with parameters, then exports and replays it', async () => {
    // 1. An agent fills in the form and submits it (the human approves the submit).
    await ok('browser_navigate', { url: stack.demo.url + '/signup' });
    const t = inner(await ok('browser_get_interactive_elements', { format: 'table' })).rows as string[];
    const ref = (label: RegExp) => t.find((r) => label.test(r))!.split(' | ')[3]!;
    await ok('browser_type', { ref: ref(/First name/), text: 'Ada' });
    await ok('browser_type', { ref: ref(/Last name/), text: 'Lovelace' });
    await ok('browser_select_option', { ref: ref(/Birth month/), label: 'July' });
    const submit = stack.call('browser_click', { ref: ref(/Submit/) });
    expect(await browser.decideApproval(true)).toMatch(/submit/i);
    expect((await submit).isError).toBe(false);
    await new Promise((r) => setTimeout(r, 500));
    expect(stack.demo.signups.at(-1)).toEqual({ first: 'Ada', last: 'Lovelace', month: 'July' });

    // 2. It is already saved as a flow for the site, with named parameters and the submit flagged.
    const list = await flows();
    expect(list.length).toBe(1);
    const id = list[0].id as string;
    const flow = inner(await ok('flow_get', { id }));
    expect(flow.steps.map((s: any) => s.action)).toEqual(['navigate', 'fill', 'fill', 'select', 'click']);
    // Personal values (a name, a birth month) are named parameters without a stored value.
    expect(flow.params.map((p: any) => [p.name, p.default])).toEqual([['first_name', undefined], ['last_name', undefined], ['birth_month', undefined]]);
    expect(flow.steps.at(-1).consequential).toBe(true);
    expect(JSON.stringify(flow.steps[1].locator)).toMatch(/First name/);
    await ok('flow_save', { id, name: 'Signup demo' });
    expect((await flows())[0]).toMatchObject({ name: 'Signup demo', saved: true, consequential: 1 });

    // 3. Replay without any model: new values, the submit still needs the human.
    const before = stack.demo.signups.length;
    const replay = stack.call('flow_run', { id, params: { first_name: 'Grace', last_name: 'Hopper', birth_month: 'July' } });
    // The replay navigates the tab, which would destroy a popup opened too early: wait until it is parked on the Submit approval.
    const dbg = (m: string) => process.env.BF_DEBUG && console.log('PHASE', m);
    dbg('replay started');
    await waitFor(async () => ((await stack.call('system_diagnostics')).data.activity as { outcome: string }[]).slice(-2).some((a) => a.outcome === 'pending'), { what: 'the replay to reach the submit approval' });
    dbg('approval pending');
    const first = await Promise.race([
      browser.decideApproval(true).catch(async (e) => { throw new Error(`${e.message}\nactivity: ${JSON.stringify(((await stack.call('system_diagnostics')).data.activity as { action: string; summary: string; outcome: string }[]).slice(-10).map((a) => `${a.action}:${a.summary}:${a.outcome}`))}`); }),
      replay.then((r) => new Error('replay ended before the submit approval: ' + JSON.stringify(r.data))),
    ]);
    if (first instanceof Error) throw first;
    dbg('approval answered');
    expect(first).toMatch(/submit/i);
    const r = await replay;
    dbg('replay finished ' + JSON.stringify(r.data).slice(0, 300));
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(r.data).toMatchObject({ ok: true, completed: 5, total: 5 });
    await new Promise((res) => setTimeout(res, 500));
    expect(stack.demo.signups.slice(before)).toEqual([{ first: 'Grace', last: 'Hopper', month: 'July' }]);
    expect((await flows()).length).toBe(1); // replaying does not record a new flow

    // 4. The exported Playwright script runs on its own, outside BrowserForge.
    const exported = await ok('flow_export', { id, format: 'playwright-ts', includeDefaults: true, path: path.join(stack.home, 'exports', 'signup.ts') });
    expect(exported.consequentialSteps).toEqual([5]);
    const esbuild = path.join(ROOT, 'node_modules/.bin/esbuild');
    const out = path.join(scratch, 'flow.mjs');
    execFileSync(esbuild, [exported.written, '--bundle=false', '--format=esm', `--outfile=${out}`, '--log-level=error'], { stdio: 'pipe' });
    const env = { ...process.env, HEADLESS: '1', BROWSER_PATH: findChromium(), FLOW_PARAM_FIRST_NAME: 'Katherine', FLOW_PARAM_LAST_NAME: 'Lovelace', FLOW_PARAM_BIRTH_MONTH: 'July' };
    const run = async (extra: Record<string, string>) => {
      try {
        const r = await execAsync('node', [out], { env: { ...env, ...extra }, timeout: 90_000, cwd: scratch });
        return { code: 0, out: r.stdout + r.stderr };
      } catch (e: any) {
        return { code: e.code as number, out: String(e.stderr ?? '') + String(e.stdout ?? '') };
      }
    };
    const count = stack.demo.signups.length;
    const unconfirmed = await run({});
    expect(unconfirmed.code, unconfirmed.out).toBe(3); // stops before the consequential step
    expect(unconfirmed.out).toMatch(/consequential.*FLOW_CONFIRM=1/);
    expect(stack.demo.signups.length).toBe(count);
    const confirmed = await run({ FLOW_CONFIRM: '1' });
    expect(confirmed.code, confirmed.out).toBe(0);
    expect(stack.demo.signups.at(-1)).toEqual({ first: 'Katherine', last: 'Lovelace', month: 'July' }); // every value comes from a parameter
  });

  it('records and replays controls inside same-origin and cross-origin iframes', async () => {
    await ok('browser_navigate', { url: stack.demo.url + '/frames' });
    await new Promise((r) => setTimeout(r, 1500));
    const rows = inner(await ok('browser_get_interactive_elements', { format: 'table' })).rows as string[];
    const emailRows = rows.filter((r) => /Frame email/.test(r));
    const saveRows = rows.filter((r) => /Save frame/.test(r));
    expect(emailRows.length).toBe(2);
    for (const [i, v] of ['same@x.test', 'cross@x.test'].entries()) {
      await ok('browser_type', { ref: emailRows[i]!.split(' | ')[3], text: v });
      await ok('browser_click', { ref: saveRows[i]!.split(' | ')[3] });
    }
    const list = await flows();
    const framesFlow = inner(await ok('flow_get', { id: list[0].id }));
    const frameSteps = framesFlow.steps.filter((s: any) => s.frame);
    expect(frameSteps.length).toBe(4);
    expect(new Set(frameSteps.map((s: any) => new URL(s.frame.url).hostname))).toEqual(new Set(['127.0.0.1', 'localhost']));
    expect(await browser.evalInPage<any[]>('return window.__msgs')).toEqual([{ email: 'same@x.test' }, { email: 'cross@x.test' }]);

    // Replay with other values: each value must land in its own frame.
    const run = await ok('flow_run', { id: list[0].id, params: { frame_email: 'a@x.test', frame_email_2: 'b@x.test' } });
    expect(run).toMatchObject({ ok: true });
    expect(await browser.evalInPage<any[]>('return window.__msgs')).toEqual([{ email: 'a@x.test' }, { email: 'b@x.test' }]);
    // Chrome Recorder JSON cannot address an iframe by its address, so it refuses instead of replaying in the wrong document.
    const rec = await stack.call('flow_export', { id: list[0].id, format: 'puppeteer-replay', path: path.join(stack.home, 'exports', 'frames.json') });
    expect(rec.data.error.code).toBe('INVALID_ARGUMENTS');
    expect(rec.data.error.message).toMatch(/iframe.*playwright-ts/);
  });

  it('refuses unknown formats, path escapes and bad ids; recording can be switched off', async () => {
    const id = (await flows())[0].id as string;
    expect((await stack.call('flow_export', { id, format: 'cobol' })).data.error.message).toMatch(/Available: .*playwright-ts/);
    expect((await stack.call('flow_export', { id, format: 'json', path: '/etc/evil.json' })).data.error.code).toBe('PATH_NOT_ALLOWED');
    expect((await stack.call('flow_get', { id: '../../etc/passwd' })).isError).toBe(true);
    const n = (await flows()).length;
    await ok('flow_record', { on: false });
    await ok('browser_navigate', { url: stack.demo.url + '/gate' });
    await ok('browser_click', { selector: '#parent-btn' }).catch(() => undefined);
    expect((await flows()).length).toBe(n);
    await ok('flow_record', { on: true });
  });

  it('records and replays controls inside an open shadow root, tells equal buttons apart, remembers checkbox state, and refuses a disabled button', async () => {
    const begin = await ok('flow_task_begin', { name: 'Shadow demo' }); // its own flow, whatever was recorded before
    await ok('browser_navigate', { url: stack.demo.url + '/shadow' });
    const refs = async () => {
      const t = inner(await ok('browser_get_interactive_elements', { format: 'table' })).rows as string[];
      return (label: RegExp, n = 0) => t.filter((r) => label.test(r))[n]!.split(' | ')[3]!;
    };
    let ref = await refs();
    // The submit is disabled until the input has text: nothing is clicked or recorded, and no approval is asked for.
    const refused = await stack.call('browser_click', { ref: ref(/Save shadow/) });
    expect(refused.isError).toBe(true);
    expect(refused.data.error.code).toBe('ELEMENT_DISABLED');
    await ok('browser_type', { ref: ref(/Shadow email/), text: 'ada@shadow.test' });
    await ok('browser_click', { ref: ref(/Remember me/) });
    ref = await refs();
    await ok('browser_click', { ref: ref(/Save shadow/) });
    await ok('browser_click', { ref: ref(/\| Add \|/, 1) });
    expect(await browser.evalInPage<any[]>('return window.__saved')).toEqual([{ email: 'ada@shadow.test', remember: true }]);
    expect(await browser.evalInPage<number[]>('return window.__adds')).toEqual([2]);

    const end = await ok('flow_task_end', { taskId: begin.taskId, outcome: 'success' });
    const flow = inner(await ok('flow_get', { id: end.flowId }));
    const step = (re: RegExp) => flow.steps.find((s: any) => re.test(s.label ?? ''));
    expect(step(/Shadow email/).locator.shadow).toHaveLength(1);
    expect(step(/Shadow email/).locator.shadow[0]).toMatch(/shadow-form$/);
    expect(step(/Shadow email/).locator.xpath).toBeUndefined(); // an xpath cannot cross a shadow root
    expect(step(/Remember me/).state).toBe('checked');
    expect(flow.steps.filter((s: any) => /"Add"/.test(s.label ?? '')).map((s: any) => s.locator.nth)).toEqual([1]);
    expect(flow.steps.some((s: any) => /Save shadow/.test(s.label ?? '') && s.locator.disabled)).toBe(false); // it was enabled when clicked
    expect(flow).toMatchObject({ outcome: 'success', outcomeBy: 'agent' });

    // Replay on a fresh page with another value: the shadow input is found through its host, the checkbox is only clicked when needed, the right "Add" is pressed.
    await ok('browser_navigate', { url: stack.demo.url + '/shadow' });
    const run = await ok('flow_run', { id: end.flowId, params: { shadow_email: 'grace@shadow.test' } });
    expect(run).toMatchObject({ ok: true });
    expect(await browser.evalInPage<any[]>('return window.__saved')).toEqual([{ email: 'grace@shadow.test', remember: true }]);
    expect(await browser.evalInPage<number[]>('return window.__adds')).toEqual([2]);
    expect(inner(await ok('flow_get', { id: end.flowId })).runs).toMatchObject({ count: 1, ok: 1 });
    expect((await ok('flow_export', { id: end.flowId, format: 'playwright-ts', path: path.join(stack.home, 'exports', 'shadow.ts') })).code).toContain('setChecked(true)');
  });
});
