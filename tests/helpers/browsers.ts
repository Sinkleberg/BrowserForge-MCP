import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { App } from '../../apps/mcp-server/src/app.js';
import { ROOT, waitFor } from './stack.js';

export interface BrowserHandle {
  kind: 'firefox' | 'chromium';
  /** Open `url` in a new tab/page controlled directly (not through the extension). */
  openPage(url: string): Promise<unknown>;
  /** Evaluate JS in the page context of the most recently opened page (test-side inspection only). */
  evalInPage<T>(script: string): Promise<T>;
  /** Do something the way a person does, with real (trusted) browser input events, in the most recently opened page. */
  userFill(css: string, text: string): Promise<void>;
  userClick(css: string): Promise<void>;
  /** Choose the LAST option of a <select> (End key on Chromium, a click on Firefox): one trusted change event either way. */
  userPickLast(css: string): Promise<void>;
  /** Open the extension popup in a tab, press Approve/Deny on the first pending approval, and return the prompt text. */
  decideApproval(approve: boolean): Promise<string>;
  /** Text and state of the popup (status line, activity). */
  popupSnapshot(): Promise<{ status: string; activity: string; approvals: number }>;
  /** Press a popup button by element id (e.g. 'stop', 'pause'). */
  popupClick(id: string): Promise<void>;
  /** Send a popup control message (e.g. 'setYolo', 'getHistory') exactly as the popup does. */
  popupMessage<T = any>(op: string, extra?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

function prepareExtension(app: App, variant: 'firefox-e2e' | 'chrome-e2e'): string {
  const src = path.join(ROOT, 'apps/firefox-extension/dist', variant);
  if (!fs.existsSync(path.join(src, 'manifest.json'))) throw new Error('Extension not built: run npm run build');
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), `bf-ext-${variant}-`));
  fs.cpSync(src, dst, { recursive: true });
  fs.writeFileSync(path.join(dst, 'e2e-config.json'), JSON.stringify({ serverUrl: `ws://127.0.0.1:${app.port}/ext`, token: app.ctx.config.extensionToken }));
  return dst;
}

export async function launchFirefox(app: App): Promise<BrowserHandle> {
  const { Builder, By } = await import('selenium-webdriver');
  const firefox = (await import('selenium-webdriver/firefox.js')).default;
  const extDir = prepareExtension(app, 'firefox-e2e');
  const opts = new firefox.Options();
  if (process.env.BF_HEADED !== '1') opts.addArguments('-headless');
  const bin = '/snap/firefox/current/usr/lib/firefox/firefox';
  opts.setBinary(fs.existsSync(bin) ? bin : 'firefox');
  const FF_UUID = '11111111-2222-4333-8444-555555555555';
  opts.setPreference('extensions.webextensions.uuids', JSON.stringify({ 'browserforge@browserforge.local': FF_UUID }));
  const popupUrl = `moz-extension://${FF_UUID}/popup.html`;
  const service = new firefox.ServiceBuilder(fs.existsSync('/snap/bin/geckodriver') ? '/snap/bin/geckodriver' : 'geckodriver');
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).setFirefoxService(service).build();
  await (driver as unknown as { installAddon(p: string, temporary: boolean): Promise<string> }).installAddon(extDir, true);
  await waitFor(() => app.ctx.hub.listPeers().some((p) => p.connected), { timeoutMs: 30_000, what: 'Firefox extension to connect' });
  // Marionette cannot script privileged moz-extension:// tabs, so the (web-accessible, e2e-only) popup is embedded as an iframe.
  const withPopup = async <T>(fn: () => Promise<T>): Promise<T> => {
    await driver.executeScript(`var f=document.createElement('iframe');f.id='bf-popup-frame';f.src=${JSON.stringify(popupUrl)};f.style='position:fixed;top:0;left:0;width:380px;height:700px;z-index:2147483647;background:#fff';document.body.appendChild(f)`);
    const frame = await driver.findElement(By.id('bf-popup-frame'));
    await driver.switchTo().frame(frame);
    try {
      await waitFor(async () => (await driver.executeScript("return document.getElementById('status') && document.getElementById('status').textContent")) as string, { what: 'popup render' });
      return await fn();
    } finally {
      await driver.switchTo().defaultContent();
      await driver.executeScript("var f=document.getElementById('bf-popup-frame');if(f)f.remove()");
    }
  };
  return {
    kind: 'firefox',
    decideApproval: (approve) =>
      withPopup(async () => {
        const text = (await waitFor(async () => (await driver.executeScript("var l=document.querySelector('#approvalList li');return l&&l.textContent")) as string, { what: 'approval prompt' }));
        await driver.executeScript(`document.querySelectorAll('#approvalList li button')[${approve ? 0 : 1}].click()`);
        await waitFor(async () => (await driver.executeScript("return document.querySelectorAll('#approvalList li').length")) === 0, { what: 'approval to clear' });
        return text;
      }),
    popupSnapshot: () =>
      withPopup(async () => ({
        status: (await driver.executeScript("return document.getElementById('status').textContent")) as string,
        activity: (await driver.executeScript("return document.getElementById('activity').textContent")) as string,
        approvals: (await driver.executeScript("return document.querySelectorAll('#approvalList li').length")) as number,
      })),
    popupMessage: (op, extra = {}) =>
      withPopup(async () => (await driver.executeAsyncScript(
        `var done=arguments[arguments.length-1];var a=(globalThis.browser||globalThis.chrome);Promise.resolve(a.runtime.sendMessage(Object.assign({kind:'bf-popup',op:${JSON.stringify(op)}},${JSON.stringify(extra)}))).then(done)`)) as never),
    popupClick: (id) => withPopup(async () => { await driver.executeScript(`document.getElementById(${JSON.stringify(id)}).click()`); await new Promise((r) => setTimeout(r, 400)); }),
    openPage: async (url) => {
      await driver.switchTo().newWindow('tab');
      await driver.get(url);
    },
    evalInPage: async (script) => (await driver.executeScript(`return (function(){${script}})()`)) as never,
    userFill: async (css, text) => { await driver.findElement(By.css(css)).sendKeys(text); },
    userClick: async (css) => { await driver.findElement(By.css(css)).click(); },
    userPickLast: async (css) => { await (await driver.findElement(By.css(css))).findElement(By.xpath('.//option[last()]')).click(); },
    close: async () => {
      await driver.quit().catch(() => undefined);
      fs.rmSync(extDir, { recursive: true, force: true });
    },
  };
}

/** Playwright's bundled Chromium (Chrome-for-Testing style) still honours --load-extension, unlike branded Chrome >= 137. */
export function findChromium(): string {
  if (process.env.BF_CHROMIUM) return process.env.BF_CHROMIUM;
  const base = path.join(os.homedir(), '.cache/ms-playwright');
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])) : [];
  for (const d of dirs) {
    const exe = path.join(base, d, 'chrome-linux64/chrome');
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error('No Playwright Chromium found. Run: npx playwright install chromium (or set BF_CHROMIUM)');
}

export async function launchChromium(app: App): Promise<BrowserHandle> {
  const { chromium } = await import('playwright');
  const extDir = prepareExtension(app, 'chrome-e2e');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-chromium-'));
  const ctx = await chromium.launchPersistentContext(userData, {
    executablePath: findChromium(),
    headless: process.env.BF_HEADED !== '1',
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, ...(process.env.BF_HEADED === '1' ? [] : ['--headless=new'])],
  });
  await waitFor(() => app.ctx.hub.listPeers().some((p) => p.connected), { timeoutMs: 30_000, what: 'Chromium extension to connect' });
  let last = ctx.pages()[0];
  const popupUrl = 'chrome-extension://omjlkhmfagboopakfflhapniolpfbogp/popup.html';
  // The popup is embedded in the current page (not opened as a tab) so the active tab — the agent's default target — never changes.
  const withPopup = async <T>(fn: (f: import('playwright').Frame) => Promise<T>): Promise<T> => {
    const page = last!;
    await page.evaluate((u) => {
      const f = document.createElement('iframe');
      f.id = 'bf-popup-frame';
      f.src = u;
      f.style.cssText = 'position:fixed;top:0;left:0;width:380px;height:700px;z-index:2147483647;background:#fff';
      document.body.appendChild(f);
    }, popupUrl);
    const handle = await page.waitForSelector('#bf-popup-frame');
    const frame = (await handle.contentFrame())!;
    await frame.waitForFunction(() => document.getElementById('status')?.textContent);
    try {
      return await fn(frame);
    } finally {
      await page.evaluate(() => document.getElementById('bf-popup-frame')?.remove());
    }
  };
  return {
    kind: 'chromium',
    decideApproval: (approve) =>
      withPopup(async (p) => {
        await p.waitForSelector('#approvalList li');
        const text = (await p.textContent('#approvalList li')) ?? '';
        await p.click(`#approvalList li button >> nth=${approve ? 0 : 1}`);
        await p.waitForFunction(() => document.querySelectorAll('#approvalList li').length === 0);
        return text;
      }),
    popupSnapshot: () =>
      withPopup(async (p) => ({
        status: (await p.textContent('#status')) ?? '',
        activity: (await p.textContent('#activity')) ?? '',
        approvals: await p.locator('#approvalList li').count(),
      })),
    popupMessage: (op, extra = {}) =>
      withPopup(async (p) => (await p.evaluate(([o, e]) => ((globalThis as any).browser ?? (globalThis as any).chrome).runtime.sendMessage({ kind: 'bf-popup', op: o, ...(e as object) }), [op, extra] as const)) as never),
    popupClick: (id) => withPopup(async (p) => { await p.click('#' + id); await p.waitForTimeout(400); }),
    openPage: async (url) => {
      last = await ctx.newPage();
      await last!.goto(url);
    },
    evalInPage: async (script) => (await last!.evaluate(`(function(){${script}})()`)) as never,
    userFill: async (css, text) => { await last!.click(css); await last!.keyboard.type(text); },
    userClick: async (css) => { await last!.click(css); },
    userPickLast: async (css) => { await last!.focus(css); await last!.keyboard.press('End'); },
    close: async () => {
      await ctx.close().catch(() => undefined);
      fs.rmSync(extDir, { recursive: true, force: true });
      fs.rmSync(userData, { recursive: true, force: true });
    },
  };
}
