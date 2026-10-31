import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchChromium, launchFirefox, type BrowserHandle } from '../helpers/browsers.js';
import { startStack, type Stack } from '../helpers/stack.js';

const kinds = (process.env.BF_BROWSERS ?? 'firefox,chromium').split(',') as ('firefox' | 'chromium')[];

describe.each(kinds)('Agent window — %s', (kind) => {
  let stack: Stack;
  let browser: BrowserHandle;
  beforeAll(async () => {
    stack = await startStack();
    browser = kind === 'firefox' ? await launchFirefox(stack.app) : await launchChromium(stack.app);
    await browser.openPage(stack.demo.url + '/'); // the person's own tab
  });
  afterAll(async () => {
    await browser?.close();
    await stack?.close();
  });

  const tabs = async (): Promise<any[]> => (await stack.call('browser_get_tabs')).data.data.tabs;
  const userTab = async () => (await tabs()).find((t) => new URL(t.url).pathname === '/' && !t.agent);
  const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));
  const state = async () => (await browser.popupMessage('getState')).state;

  it('is off by default: the agent uses the tab the person is looking at', async () => {
    expect((await state()).agentWindow).toBe(false);
    await stack.call('browser_navigate', { url: stack.demo.url + '/signup' });
    expect((await tabs()).some((t) => t.agent)).toBe(false);
    expect(await browser.evalInPage<string>('return location.pathname')).toBe('/signup'); // it navigated the person's tab
    await browser.openPage(stack.demo.url + '/'); // give the person back a tab on "/"
  });

  it('with it on, a navigation opens the agent window and leaves the person\'s tab alone', async () => {
    await browser.popupMessage('setAgentWindow', { on: true });
    const before = await userTab();
    expect(before).toBeDefined();
    const nav = (await stack.call('browser_navigate', { url: stack.demo.url + '/signup' })).data.data;
    expect(nav.agent).toBe(true);
    expect(nav.inAgentWindow).toBe(true);
    expect(nav.windowId).not.toBe(before.windowId);
    expect(await browser.evalInPage<string>('return location.pathname')).toBe('/'); // the person's page did not move
    // Reads and actions go to the agent's page.
    const text = JSON.stringify((await stack.call('browser_get_page_text')).data);
    expect(text).toMatch(/Birth month|First name/);
    expect((await state()).agentWindowOpen).toBe(true);
  });

  it('opens further tabs inside the agent window, and can still work in one of the person\'s on purpose', async () => {
    const t = (await stack.call('browser_navigate', { url: stack.demo.url + '/', newTab: true })).data.data;
    expect(t.inAgentWindow).toBe(true);
    const mine = (await userTab())!;
    const picked = (await stack.call('browser_select_tab', { tabId: mine.tabId })).data;
    expect(picked.inAgentWindow).toBeUndefined();
    expect(JSON.stringify((await stack.call('browser_get_page_text')).data)).toBeTruthy();
    // Back in the agent's window for what follows.
    const agentTab = (await tabs()).find((x) => x.agent && x.inAgentWindow)!;
    await stack.call('browser_select_tab', { tabId: agentTab.tabId });
  });

  it('lets the person take over, and hand back', async () => {
    await browser.popupMessage('takeOver');
    const blocked = await stack.call('browser_get_page_text');
    expect(blocked.isError).toBe(true);
    expect(blocked.data.error.code).toBe('STOPPED');
    expect((await browser.popupSnapshot()).activity).toMatch(/took over/i);
    await browser.popupMessage('handBack');
    expect((await stack.call('browser_get_page_text')).isError).toBe(false);
    expect((await browser.popupSnapshot()).activity).toMatch(/handed control back/i);
  });

  it('tells the agent what to do when its window is gone, and opens a new one on the next navigation', async () => {
    await browser.popupMessage('closeAgentWindow');
    await settle(800);
    expect((await state()).agentWindowOpen).toBe(false);
    const r = await stack.call('browser_get_page_text');
    expect(r.isError).toBe(true);
    expect(r.data.error.message).toMatch(/browser_navigate/);
    const nav = (await stack.call('browser_navigate', { url: stack.demo.url + '/signup' })).data.data;
    expect(nav.inAgentWindow).toBe(true);
    expect((await userTab())).toBeDefined(); // the person's tab survived all of it
  });
});
