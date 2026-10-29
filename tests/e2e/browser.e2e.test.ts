import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchChromium, launchFirefox, type BrowserHandle } from '../helpers/browsers.js';
import { startStack, waitFor, type Stack } from '../helpers/stack.js';

const kinds = (process.env.BF_BROWSERS ?? 'firefox,chromium').split(',') as ('firefox' | 'chromium')[];

describe.each(kinds)('browser control — %s', (kind) => {
  let stack: Stack;
  let browser: BrowserHandle;
  const demo = () => stack.demo.url;

  beforeAll(async () => {
    stack = await startStack();
    browser = kind === 'firefox' ? await launchFirefox(stack.app) : await launchChromium(stack.app);
    await browser.openPage(demo() + '/');
  });
  afterAll(async () => {
    await browser?.close();
    await stack?.close();
  });

  const call = (n: string, a: Record<string, unknown> = {}) => stack.call(n, a);
  const ok = async (n: string, a: Record<string, unknown> = {}) => {
    const r = await call(n, a);
    expect(r.isError, `${n} failed: ${JSON.stringify(r.data)}`).toBe(false);
    return r.data;
  };
  const inner = (d: any) => d.data ?? d;
  const findEl = async (pred: (e: any) => boolean) => {
    const els = inner(await ok('browser_get_interactive_elements')).elements as any[];
    const el = els.find(pred);
    if (!el) throw new Error('element not found: ' + JSON.stringify(els.map((e) => e.id ?? e.text)));
    return el;
  };

  it('gates an icon-only send button whose label is on a child svg, and keeps the page untouched until approved', async () => {
    await ok('browser_navigate', { url: demo() + '/gate' });
    const denied = call('browser_click', { selector: '#icon-send' });
    expect(await browser.decideApproval(false)).toMatch(/send/i);
    expect((await denied).data.error.code).toBe('APPROVAL_DENIED');
    expect(await browser.evalInPage<number>('return window.__sent')).toBe(0);
    const approved = call('browser_click', { selector: '#icon-send' });
    await browser.decideApproval(true);
    expect((await approved).isError).toBe(false);
    expect(await browser.evalInPage<number>('return window.__sent')).toBe(1);
  });

  it('selects an option in a custom ARIA dropdown that closes on scroll and only reacts to mousedown', async () => {
    await ok('browser_navigate', { url: demo() + '/gate' });
    const r = await ok('browser_select_option', { selector: '#month', label: 'July' });
    expect(inner(r).selected).toBe('July');
    expect(await browser.evalInPage<string>('return window.__month')).toBe('July');
  });

  it('returns a compact numbered table of visible controls', async () => {
    await ok('browser_navigate', { url: demo() + '/gate' });
    const t = inner(await ok('browser_get_interactive_elements', { format: 'table' }));
    expect(t.rows.some((r: string) => /combobox \| Select Month \| /.test(r))).toBe(true);
    expect(t.rows[0]).toMatch(/^1 \| .+ \| .*\| \S+:\d+$/);
  });

  it('finishes same-document navigation quickly instead of waiting for the load timeout', async () => {
    await ok('browser_navigate', { url: demo() + '/gate#a' });
    const t0 = Date.now();
    await ok('browser_navigate', { url: demo() + '/gate#b' });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('records every approval decision in a persistent history', async () => {
    await ok('browser_navigate', { url: demo() + '/gate' });
    await browser.popupMessage('clearHistory');
    const denied = call('browser_click', { selector: '#icon-send' });
    await browser.decideApproval(false);
    await denied;
    const approved = call('browser_click', { selector: '#icon-send' });
    await browser.decideApproval(true);
    await approved;
    const h = (await browser.popupMessage<{ history: any[] }>('getHistory')).history;
    expect(h.map((r) => [r.outcome, r.by])).toEqual([['denied', 'human'], ['approved', 'human']]);
    expect(h[0].title).toMatch(/send/i);
  });

  it('YOLO auto-approves without a prompt, logs it as yolo, and can be turned off again', async () => {
    await ok('browser_navigate', { url: demo() + '/gate' });
    await browser.popupMessage('clearHistory');
    await browser.popupMessage('setYolo', { on: true });
    try {
      expect(inner(await ok('system_diagnostics')).checks.find((c: any) => c.name === 'approval-mode')).toMatchObject({ ok: false });
      const before = await browser.evalInPage<number>('return window.__sent');
      expect((await call('browser_click', { selector: '#icon-send' })).isError).toBe(false); // no decideApproval(): would hang if it prompted
      expect(await browser.evalInPage<number>('return window.__sent')).toBe(before + 1);
      const h = (await browser.popupMessage<{ history: any[] }>('getHistory')).history;
      expect(h.at(-1)).toMatchObject({ outcome: 'approved', by: 'yolo' });
      expect((await browser.popupSnapshot()).approvals).toBe(0);
    } finally {
      await browser.popupMessage('setYolo', { on: false });
    }
    // Back to normal: the gate is active again.
    const gated = call('browser_click', { selector: '#icon-send' });
    await browser.decideApproval(false);
    expect((await gated).data.error.code).toBe('APPROVAL_DENIED');
  });

  it('cannot turn YOLO on through saveSettings', async () => {
    await browser.popupMessage('saveSettings', { yolo: true });
    await ok('browser_navigate', { url: demo() + '/gate' });
    const gated = call('browser_click', { selector: '#icon-send' });
    await browser.decideApproval(false);
    expect((await gated).data.error.code).toBe('APPROVAL_DENIED');
  });

  it('reports the connected browser in system_status', async () => {
    const s = await ok('system_status');
    expect(s.connected).toBe(true);
    expect(s.browsers[0].kind).toBe(kind === 'firefox' ? 'firefox' : 'chrome');
  });

  it('lists tabs and the active tab (marked untrusted)', async () => {
    const tabs = await ok('browser_get_tabs');
    expect(tabs.untrustedWebContent).toBe(true);
    expect(tabs.data.tabs.length).toBeGreaterThan(0);
    const active = await ok('browser_get_active_tab');
    expect(active.data.url).toContain('127.0.0.1');
  });

  it('navigates, reads text and refuses non-http urls', async () => {
    const nav = await ok('browser_navigate', { url: demo() + '/' });
    expect(nav.data.url).toBe(demo() + '/');
    expect(JSON.stringify(await ok('browser_get_page_text'))).toContain('Demo site for integration tests');
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'about:config', 'data:text/html,hi']) {
      const r = await call('browser_navigate', { url });
      expect(r.isError).toBe(true);
      expect(r.data.error.code).toBe('INVALID_ARGUMENTS');
    }
  });

  it('clicks, types and waits for late elements', async () => {
    await ok('browser_navigate', { url: demo() + '/' });
    const btn = await findEl((e) => e.id === 'counter');
    await ok('browser_click', { ref: btn.ref });
    expect(await browser.evalInPage<string>("return document.getElementById('counter').textContent")).toBe('clicked 1');
    const input = await findEl((e) => e.id === 'search');
    await ok('browser_type', { ref: input.ref, text: 'hello world' });
    expect(await browser.evalInPage<string>("return document.getElementById('search').value")).toBe('hello world');
    const w = await ok('browser_wait_for_element', { selector: '#late-el', state: 'visible', timeoutMs: 8000 });
    expect(w.satisfied).toBe(true);
    const miss = await call('browser_wait_for_element', { selector: '#never', timeoutMs: 600 });
    expect(miss.isError).toBe(true);
    expect(miss.data.error.code).toBe('TIMEOUT');
  });

  it('rejects stale element refs after navigation', async () => {
    await ok('browser_navigate', { url: demo() + '/' });
    const btn = await findEl((e) => e.id === 'counter');
    await ok('browser_navigate', { url: demo() + '/apply' });
    const r = await call('browser_click', { ref: btn.ref });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe('STALE_REF');
  });

  it('discovers forms with labels, required flags and options; never returns password values', async () => {
    await ok('browser_navigate', { url: demo() + '/apply' });
    const forms = inner(await ok('browser_get_forms')).forms as any[];
    expect(forms).toHaveLength(1);
    const f = forms[0];
    const byName = Object.fromEntries(f.fields.map((x: any) => [x.name, x]));
    expect(byName.full_name.label).toMatch(/Full name/);
    expect(byName.full_name.required).toBe(true);
    expect(byName.country.options.map((o: any) => o.value)).toContain('FR');
    expect(byName.password.value).toBeUndefined();
    expect(f.requiredMissing).toEqual(expect.arrayContaining([expect.stringMatching(/Full name/), expect.stringMatching(/Email/)]));
  });

  it('fills a form by label, select and checkbox without submitting', async () => {
    await ok('browser_navigate', { url: demo() + '/apply' });
    const r = await ok('browser_fill_form', {
      fields: [
        { key: 'Full name', value: 'Ada Lovelace' },
        { key: 'Email address', value: 'ada@example.com' },
        { key: 'Country', value: 'France' },
        { key: 'Years of experience', value: '7' },
        { key: 'Cover letter', value: 'Dear team,\nHello.' },
        { key: 'terms', value: 'true' },
      ],
    });
    expect(r.filled).toHaveLength(6);
    expect(r.notFound).toEqual([]);
    expect(r.submitted).toBe(false);
    const vals = await browser.evalInPage<Record<string, unknown>>("var f=document.getElementById('application');return {n:f.full_name.value,e:f.email.value,c:f.country.value,y:f.years.value,t:f.terms.checked,l:f.cover_letter.value}");
    expect(vals).toEqual({ n: 'Ada Lovelace', e: 'ada@example.com', c: 'FR', y: '7', t: true, l: 'Dear team,\nHello.' });
    expect(stack.demo.applications).toHaveLength(0);
  });

  it('blocks submission until the human approves (deny, then approve)', async () => {
    await ok('browser_navigate', { url: demo() + '/apply' });
    await ok('browser_fill_form', { fields: [{ key: 'Full name', value: 'Ada Lovelace' }, { key: 'Email address', value: 'ada@example.com' }] });
    const submitBtn = await findEl((e) => e.id === 'submit');

    // Attempt 1: human denies.
    const denied = call('browser_click', { ref: submitBtn.ref });
    const prompt = await browser.decideApproval(false);
    expect(prompt).toMatch(/Submit/i);
    const dr = await denied;
    expect(dr.isError).toBe(true);
    expect(dr.data.error.code).toBe('APPROVAL_DENIED');
    await new Promise((r) => setTimeout(r, 500));
    expect(stack.demo.applications).toHaveLength(0);

    // Attempt 2: human approves.
    const approved = call('browser_click', { ref: submitBtn.ref });
    await browser.decideApproval(true);
    const ar = await approved;
    expect(ar.isError, JSON.stringify(ar.data)).toBe(false);
    await waitFor(() => stack.demo.applications.length === 1, { what: 'application to reach the server' });
    expect(stack.demo.applications[0]).toMatchObject({ full_name: 'Ada Lovelace', email: 'ada@example.com' });
    await waitFor(async () => (await browser.evalInPage<string>("return document.getElementById('result').textContent")).includes('Application received'), { what: 'confirmation text' });
  });

  it('requires approval for fill_form submit:true and for file uploads; validates file paths', async () => {
    await ok('browser_navigate', { url: demo() + '/apply' });
    const cvDir = path.join(stack.app.ctx.config.configDir, 'files');
    fs.mkdirSync(cvDir, { recursive: true });
    fs.writeFileSync(path.join(cvDir, 'cv.txt'), 'My CV');
    const before = stack.demo.applications.length;

    const p = call('browser_fill_form', { fields: [{ key: 'Full name', value: 'Grace Hopper' }, { key: 'Email address', value: 'grace@example.com' }], files: [{ key: 'CV', filePath: path.join(cvDir, 'cv.txt') }], submit: true });
    const prompt = await browser.decideApproval(true);
    expect(prompt).toContain('cv.txt');
    const r = await p;
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(r.data.submitted).toBe(true);
    await waitFor(() => stack.demo.applications.length === before + 1, { what: 'submission' });
    expect(stack.demo.applications.at(-1)).toMatchObject({ full_name: 'Grace Hopper', cv_name: 'cv.txt' });

    for (const bad of ['/etc/passwd', path.join(cvDir, '..', '..', '..', 'etc', 'passwd'), '~/.ssh/id_rsa']) {
      const e = await call('browser_fill_form', { fields: [], files: [{ key: 'CV', filePath: bad }] });
      expect(e.isError).toBe(true);
      expect(e.data.error.code).toBe('PATH_NOT_ALLOWED');
    }
  });

  it('job-application flow: profile → preview → fill → CV approval → validate → cover letter (never auto-submits)', async () => {
    await ok('browser_navigate', { url: demo() + '/apply' });
    const submittedBefore = stack.demo.applications.length;
    const cvDir = path.join(stack.app.ctx.config.configDir, 'files');
    fs.mkdirSync(cvDir, { recursive: true });
    fs.writeFileSync(path.join(cvDir, 'ada-cv.txt'), 'CV');
    // Consent is mandatory.
    expect((await call('form_profile_save', { name: 'ada', data: { email: 'x@y.z' } })).isError).toBe(true);
    const saved = await ok('form_profile_save', { name: 'ada', consent: true, data: { fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+33102030405', country: 'France', yearsExperience: '7', cvPath: path.join(cvDir, 'ada-cv.txt'), coverLetterTemplate: 'Dear {{hiringManager}}, I am {{fullName}} and I would like to join {{company}}.' } });
    expect(saved.keys).toContain('email');
    expect(JSON.stringify(await ok('form_profile_list'))).not.toContain('ada@example.com');
    expect(fs.statSync(path.join(stack.app.ctx.config.configDir, 'profiles.json')).mode & 0o777).toBe(0o600);

    const found = inner(await ok('form_discover', { profile: 'ada' })).forms[0];
    expect(found.fields.find((x: any) => x.name === 'password').humanOnly).toBe(true);
    expect(found.fields.find((x: any) => x.name === 'terms').humanOnly).toBe(true);

    const preview = inner(await ok('form_fill_from_profile', { profile: 'ada' }));
    expect(preview.dryRun).toBe(true);
    expect(preview.willFill.map((w: any) => w.key).sort()).toEqual(['country', 'email', 'fullName', 'phone', 'yearsExperience']);
    const human = preview.needsHuman.map((n: any) => n.label).join('|');
    expect(human).toMatch(/Password/);
    expect(human).toMatch(/terms/);
    expect(await browser.evalInPage<string>("return document.getElementById('email').value")).toBe(''); // dry run touched nothing

    const filled = inner(await ok('form_fill_from_profile', { profile: 'ada', dryRun: false }));
    expect(filled.result.filled).toHaveLength(5);
    const v = await browser.evalInPage<Record<string, unknown>>("var f=document.getElementById('application');return {n:f.full_name.value,e:f.email.value,c:f.country.value,y:f.years.value,t:f.terms.checked,p:f.password.value,l:f.cover_letter.value}");
    expect(v).toEqual({ n: 'Ada Lovelace', e: 'ada@example.com', c: 'FR', y: '7', t: false, p: '', l: '' });

    const attach = call('form_fill_from_profile', { profile: 'ada', dryRun: false, attachCv: true });
    expect(await browser.decideApproval(true)).toContain('ada-cv.txt');
    expect((await attach).isError).toBe(false);
    expect(await browser.evalInPage<string>("return document.getElementById('cv').files[0] && document.getElementById('cv').files[0].name")).toBe('ada-cv.txt');

    const val = inner(await ok('form_validate'));
    expect(val.complete).toBe(true);
    const prev = inner(await ok('form_preview_submission'));
    expect(JSON.stringify(prev)).not.toMatch(/hunter2/);
    expect(prev.fields.find((x: any) => x.label.startsWith('Password')).value).toBe('(hidden)');
    expect(stack.demo.applications).toHaveLength(submittedBefore); // nothing was submitted

    const letter = await ok('form_prepare_cover_letter', { profile: 'ada', values: { company: 'Acme' } });
    expect(letter.unresolvedPlaceholders).toEqual(['hiringManager']);
    expect(letter.text).toContain('I am Ada Lovelace and I would like to join Acme.');
  });

  it('types a whole multi-line message into rich-text editors in one call, and still gates sending', async () => {
    await ok('browser_navigate', { url: demo() + '/editor' });
    const els = inner(await ok('browser_get_interactive_elements')).elements as any[];
    for (const id of ['lex', 'plain', 'tb']) expect(els.find((e) => e.id === id), id).toMatchObject({ editable: true, visible: true });
    expect(els.find((e) => e.id === 'lex').label).toBe('Message');

    const lines = ['Hello ' + 'a'.repeat(150) + ' é ü 🙂', 'Second line ' + 'b'.repeat(120), 'Third ' + 'c'.repeat(100)];
    const message = lines.join('\n');
    const lexRef = els.find((e) => e.id === 'lex').ref;
    const r = inner(await ok('browser_type', { ref: lexRef, text: message }));
    expect(r.editable).toBe(true);
    expect(await browser.evalInPage<string>('return window.__model')).toBe(message); // the framework's own state, not just the DOM
    expect((await browser.evalInPage<string>("return document.getElementById('lex').innerText")).replace(/\n$/, '')).toBe(message);
    expect(await browser.evalInPage<number>('return window.__sent')).toBe(0); // newlines never act as Enter/send

    // plain contenteditable and role=textbox, including clear:true replacement
    const plain = els.find((e) => e.id === 'plain').ref;
    await ok('browser_type', { ref: plain, text: 'first draft' });
    await ok('browser_type', { ref: plain, text: message, clear: true });
    expect((await browser.evalInPage<string>("return document.getElementById('plain').innerText")).replace(/\n$/, '')).toBe(message);
    await ok('browser_fill_field', { ref: els.find((e) => e.id === 'tb').ref, value: 'replaced via fill_field' });
    expect(await browser.evalInPage<string>("return document.getElementById('tb').innerText")).toBe('replaced via fill_field');

    // targetless typing goes to the focused element; a click focuses editors
    await ok('browser_navigate', { url: demo() + '/editor' });
    const nothing = await call('browser_type', { text: 'x' });
    expect(nothing.isError).toBe(true);
    expect(nothing.data.error.code).toBe('ELEMENT_NOT_FOUND');
    await ok('browser_click', { selector: '#plain' });
    await ok('browser_type', { text: 'typed without a target' });
    expect(await browser.evalInPage<string>("return document.getElementById('plain').innerText")).toBe('typed without a target');
    // targetless typing into an <input> still works too
    await ok('browser_navigate', { url: demo() + '/' });
    await ok('browser_click', { selector: '#search' });
    await ok('browser_type', { text: 'plain input' });
    expect(await browser.evalInPage<string>("return document.getElementById('search').value")).toBe('plain input');

    // Sending needs the human: type+submit, Enter, and the Send button each prompt.
    await ok('browser_navigate', { url: demo() + '/editor' });
    const ref2 = (inner(await ok('browser_get_interactive_elements')).elements as any[]).find((e) => e.id === 'lex').ref;
    const sendRef = (inner(await ok('browser_get_interactive_elements')).elements as any[]).find((e) => e.id === 'send').ref;
    const denied = call('browser_type', { ref: ref2, text: 'should not be typed', submit: true });
    expect(await browser.decideApproval(false)).toMatch(/Enter|send/i);
    expect((await denied).data.error.code).toBe('APPROVAL_DENIED');
    expect(await browser.evalInPage<string>('return window.__model')).toBe(''); // nothing typed before approval
    const approved = call('browser_type', { ref: ref2, text: 'hello there', submit: true });
    await browser.decideApproval(true);
    expect((await approved).isError).toBe(false);
    expect(await browser.evalInPage<number>('return window.__sent')).toBe(1);
    expect(await browser.evalInPage<string>('return window.__lastSent')).toBe('hello there');

    await ok('browser_type', { ref: ref2, text: 'second' });
    const enter = call('browser_press_key', { ref: ref2, key: 'Enter' });
    await browser.decideApproval(false);
    expect((await enter).data.error.code).toBe('APPROVAL_DENIED');
    expect(await browser.evalInPage<number>('return window.__sent')).toBe(1);
    await ok('browser_press_key', { ref: ref2, key: 'Enter', modifiers: ['Shift'] }); // soft newline: no approval, no send
    expect(await browser.evalInPage<string>('return window.__model')).toBe('second\n');
    expect(await browser.evalInPage<number>('return window.__sent')).toBe(1);
    const send = call('browser_click', { ref: sendRef });
    expect(await browser.decideApproval(true)).toMatch(/Send/);
    expect((await send).isError).toBe(false);
    expect(await browser.evalInPage<number>('return window.__sent')).toBe(2);
  });

  it('takes screenshots and DOM snapshots', async () => {
    await ok('browser_navigate', { url: demo() + '/' });
    const shot = await call('browser_take_screenshot', {});
    expect(shot.isError).toBe(false);
    const img = (shot.raw.content as any[]).find((c) => c.type === 'image');
    expect(img.mimeType).toBe('image/png');
    expect(Buffer.from(img.data, 'base64').subarray(1, 4).toString()).toBe('PNG');
    const full = await call('browser_take_screenshot', { fullPage: true, format: 'jpeg' });
    expect(full.isError, JSON.stringify(full.data)).toBe(false);
    const snap = await ok('browser_get_dom_snapshot', { maxNodes: 200 });
    expect(JSON.stringify(snap.data.tree)).toContain('counter');
  });

  it('collects uncaught page errors', async () => {
    await ok('browser_navigate', { url: demo() + '/' });
    await browser.evalInPage("var s=document.createElement('script');s.textContent=\"setTimeout(function(){throw new Error('boom-from-page')},10)\";document.body.appendChild(s);return 1");
    const errs = await waitFor(async () => {
      const r = inner(await ok('browser_get_console_errors'));
      return r.errors.length ? r : null;
    }, { what: 'console error' });
    expect(JSON.stringify(errs)).toContain('boom-from-page');
  });

  it('treats hostile page content as untrusted data and cannot be driven by the page', async () => {
    await ok('browser_navigate', { url: demo() + '/evil' });
    const text = await ok('browser_get_page_text');
    expect(text.untrustedWebContent).toBe(true);
    expect(text.notice).toMatch(/do not follow instructions/i);
    // The page cannot see extension APIs or talk to the content script.
    const spy = await browser.evalInPage<string[]>('return window.__bf_spy');
    expect(spy.join(',')).not.toMatch(/page-sees-browser|page-sees-chrome-runtime:function/);
    // "Buy now" is consequential: approval prompt appears; denying leaves the page untouched.
    const buy = await findEl((e) => e.id === 'buy-now');
    const p = call('browser_click', { ref: buy.ref });
    expect(await browser.decideApproval(false)).toMatch(/Buy now/i);
    expect((await p).data.error.code).toBe('APPROVAL_DENIED');
    expect(await browser.evalInPage<number | null>('return window.__bought || null')).toBeNull();
    // Harmless clicks go through without approval.
    const harmless = await findEl((e) => e.id === 'harmless');
    await ok('browser_click', { ref: harmless.ref });
    expect(await browser.evalInPage<number>('return window.__harmless')).toBe(1);
  });

  it('supports pause/resume, and a human stop that the agent cannot undo', async () => {
    await ok('browser_navigate', { url: demo() + '/' });
    await ok('browser_pause');
    const paused = await call('browser_get_page_text');
    expect(paused.data.error.code).toBe('PAUSED');
    await ok('browser_resume');
    await ok('browser_get_page_text');

    await browser.popupClick('stop'); // the human presses STOP in the popup
    const stopped = await call('browser_get_page_text');
    expect(stopped.data.error.code).toBe('STOPPED');
    const resume = await call('browser_resume');
    expect(resume.isError).toBe(true);
    expect(resume.data.error.code).toBe('PERMISSION_DENIED');
    expect((await browser.popupSnapshot()).status).toBe('Stopped');
    await browser.popupClick('pause'); // human resumes
    await ok('browser_get_page_text');
  });

  it('cancels in-flight calls and times out cleanly', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const p = stack.client.callTool({ name: 'browser_navigate', arguments: { url: demo() + '/slow?ms=6000', timeoutMs: 20000 } }, undefined, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 800));
    ac.abort();
    await expect(p).rejects.toThrow();
    await waitFor(() => stack.app.ctx.hub.listPeers()[0]!.inFlight === 0, { what: 'in-flight to drain' });
    expect(Date.now() - started).toBeLessThan(5000);
    const t = await call('browser_navigate', { url: demo() + '/slow?ms=4000', timeoutMs: 1000 });
    expect(t.isError).toBe(true);
    expect(t.data.error.code).toBe('TIMEOUT');
    await ok('browser_navigate', { url: demo() + '/' }); // browser still healthy
  });

  it('reconnects after the server drops the socket and keeps working', async () => {
    const hub = stack.app.ctx.hub as any;
    const before = hub.listPeers()[0].reconnects;
    hub.peers.values().next().value.ws.terminate();
    await waitFor(() => hub.listPeers()[0]?.connected && hub.listPeers()[0].reconnects > before, { timeoutMs: 30_000, what: 'reconnect' });
    await ok('browser_get_tabs');
  });

  it('reports a clear error when the browser is gone', async () => {
    const hub = stack.app.ctx.hub as any;
    const peer = hub.peers.values().next().value;
    const sock = peer.ws;
    sock.terminate();
    // Immediately after the drop (before the extension reconnects) calls fail with NOT_CONNECTED or succeed after reconnect.
    const r = await call('browser_get_tabs');
    if (r.isError) expect(r.data.error.code).toBe('NOT_CONNECTED');
    await waitFor(() => hub.listPeers()[0]?.connected, { timeoutMs: 30_000, what: 'reconnect' });
  });
});
