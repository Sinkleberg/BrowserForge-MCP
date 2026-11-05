import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FlowBuilder, getExporter } from '@browserforge/flows';
import { launchChromium, launchFirefox, type BrowserHandle } from '../helpers/browsers.js';
import { shadowFlow } from '../helpers/shadow-flow.js';
import { startStack, waitFor, type Stack } from '../helpers/stack.js';

const kinds = (process.env.BF_BROWSERS ?? 'firefox,chromium').split(',') as ('firefox' | 'chromium')[];

describe.each(kinds)('exact recorded shadow scopes — %s', (kind) => {
  let stack: Stack;
  let browser: BrowserHandle;
  beforeAll(async () => {
    stack = await startStack();
    browser = kind === 'firefox' ? await launchFirefox(stack.app) : await launchChromium(stack.app);
    await browser.openPage(stack.demo.url + '/');
  });
  afterAll(async () => { await browser?.close(); await stack?.close(); });
  const results = async () => await (await fetch(stack.demo.url + '/shadow-results')).json() as Record<string, string>[];

  it('records unique CSS for repeated children directly under a shadow root', async () => {
    const begun = await stack.call('flow_task_begin', { name: 'Nested recording' });
    expect(begun.isError).toBe(false);
    expect((await stack.call('browser_navigate', { url: stack.demo.url + '/shadow-nested' })).isError).toBe(false);
    const locator = shadowFlow(stack.demo.url).steps[1]!.locator!;
    const found = await stack.app.ctx.hub.call('resolve_locator', { locator, waitMs: 0 }) as { ref: string };
    expect((await stack.call('browser_fill_field', { ref: found.ref, value: 'recorded-synthetic' })).isError).toBe(false);
    const ended = await stack.call('flow_task_end', { taskId: begun.data.taskId, outcome: 'success' });
    const flow = stack.app.ctx.flows.get(ended.data.flowId)!;
    const fill = flow.steps.find((s) => s.action === 'fill')!;
    expect(fill.locator?.shadow).toEqual(['#target', 'inner-box:nth-of-type(2)']);
    expect(fill.locator?.css).toContain('input:nth-of-type(2)');
    expect(fill.locator?.nth).toBeUndefined(); // this exact root-relative CSS is unique
    expect(await browser.evalInPage<string>('return document.querySelector("input").value')).toBe('');
  });

  it.each([false, true])('replays the intended nested control with legacy global nth ignored, iframe=%s', async (frame) => {
    const flow = stack.app.ctx.flows.store(shadowFlow(stack.demo.url, { frame }));
    const before = (await results()).length;
    const activity = ((await stack.call('system_diagnostics')).data.activity as unknown[]).length;
    const replay = stack.call('flow_run', { id: flow.id, params: { shadow_value: frame ? 'in-frame' : 'in-root' } });
    await waitFor(async () => ((await stack.call('system_diagnostics')).data.activity as { outcome: string }[]).slice(activity).some((a) => a.outcome === 'pending'), { what: 'shadow submit approval' });
    try {
      await browser.decideApproval(true); // synthetic fixture approval, never a user's browser
    } catch (error) {
      // Approving a native form navigation can destroy the popup iframe before its empty-list readback.
      // The replay result and exact POST oracle below must still prove the intended approved action succeeded.
      if (!String(error).includes('Frame was detached')) throw error;
    }
    const done = await replay;
    expect(done.isError, JSON.stringify(done.data)).toBe(false);
    expect(done.data).toMatchObject({ ok: true, completed: 3 });
    await waitFor(async () => (await results()).length > before, { what: 'synthetic shadow POST' });
    expect((await results()).slice(before)).toEqual([{ first: '', second: frame ? 'in-frame' : 'in-root', outer: 'target', inner: '2', page: '/shadow-nested' }]);
  });

  it('denying a nested submit still prevents the action', async () => {
    const flow = stack.app.ctx.flows.store(shadowFlow(stack.demo.url));
    const before = (await results()).length;
    const activity = ((await stack.call('system_diagnostics')).data.activity as unknown[]).length;
    const replay = stack.call('flow_run', { id: flow.id });
    await waitFor(async () => ((await stack.call('system_diagnostics')).data.activity as { outcome: string }[]).slice(activity).some((a) => a.outcome === 'pending'), { what: 'shadow approval to deny' });
    await browser.decideApproval(false);
    expect((await replay).data).toMatchObject({ ok: false });
    expect((await results()).length).toBe(before);
  });

  it('refuses missing, ambiguous and closed hosts, or ambiguous targets, despite matching page controls', async () => {
    expect((await stack.call('browser_navigate', { url: stack.demo.url + '/shadow-nested' })).isError).toBe(false);
    for (const locator of [
      { css: 'input[name="second"]', shadow: ['#missing'], label: 'Repeated field', testId: 'shared' },
      { css: 'input[name="second"]', shadow: ['outer-box'], label: 'Repeated field', testId: 'shared' },
      { css: 'input[name="second"]', shadow: ['#closed'], label: 'Repeated field', testId: 'shared' },
      { css: 'input', shadow: ['#target', 'inner-box:nth-of-type(2)'], label: 'Repeated field', testId: 'shared' },
    ]) {
      await expect(stack.app.ctx.hub.call('resolve_locator', { locator, waitMs: 0 })).rejects.toMatchObject({ code: 'ELEMENT_NOT_FOUND' });
    }
    expect(await browser.evalInPage<string>('return document.querySelector("input").value')).toBe('');
  });

  it('preserves a human recording refusal instead of retargeting a clipped host chain or selector', async () => {
    await browser.openPage(stack.demo.url + '/shadow-limits');
    await browser.popupMessage('setRecord', { on: true, task: 'Synthetic shadow boundary' });
    try {
      await browser.userClick('[data-case="depth-9"]'); // trusted synthetic test input in the owned browser only
      const step = await waitFor(() => stack.app.ctx.flows.list().map((row) => stack.app.ctx.flows.get(row.id)!)
        .filter((flow) => flow.source === 'human').flatMap((flow) => flow.steps)
        .find((entry) => entry.action === 'click' && entry.locator?.text === 'depth-9'), { what: 'the unrepresentable human shadow action to survive both relays' });
      expect(step.locator?.shadow).toEqual(['']);
      expect(await browser.evalInPage('return window.__boundaryClicks')).toEqual(['depth-9']);
      const b = new FlowBuilder({ id: 'refused-boundary', site: '127.0.0.1' });
      b.navigate(stack.demo.url + '/shadow-limits');
      b.add({ action: 'click', locator: step.locator });
      for (const format of ['playwright-ts', 'playwright-py', 'selenium-py', 'selenium-java']) expect(() => getExporter(format)!.generate(b.flow)).toThrow(/shadow locator/);
      const saved = stack.app.ctx.flows.store(b.flow);
      expect((await stack.call('flow_run', { id: saved.id })).data).toMatchObject({ ok: false });
      expect(await browser.evalInPage('return window.__boundaryClicks')).toEqual([]); // neither root8 decoy nor root9 was clicked
    } finally {
      await browser.popupMessage('setRecord', { on: false });
    }

    for (const locator of [
      { shadow: Array.from({ length: 8 }, (_, i) => '#level' + (i + 1)), css: '#go' },
      { shadow: Array.from({ length: 9 }, (_, i) => '#level' + (i + 1)), css: '#go' },
      ...[600, 601].flatMap((length) => [
        { shadow: ['#' + 'h'.repeat(length - 1)], css: '#go' },
        { shadow: ['#css-boundary'], css: '#' + 'g'.repeat(length - 1) },
      ]),
    ]) await expect(stack.app.ctx.hub.call('resolve_locator', { locator, waitMs: 0 })).rejects.toMatchObject({ code: 'ELEMENT_NOT_FOUND' });
    for (const locator of [
      { shadow: Array.from({ length: 7 }, (_, i) => '#level' + (i + 1)), css: '#go' },
      { shadow: ['#' + 'h'.repeat(598)], css: '#go' },
      { shadow: ['#css-boundary'], css: '#' + 'g'.repeat(598) },
    ]) expect(await stack.app.ctx.hub.call('resolve_locator', { locator, waitMs: 0 })).toHaveProperty('ref');
    expect(await browser.evalInPage('return window.__boundaryClicks')).toEqual([]);
  });
});
