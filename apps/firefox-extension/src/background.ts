/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from 'zod';
import { ACTIONS, HelloAckSchema, PROTOCOL_VERSION, RequestSchema, CancelSchema, isActionName, isNavigableUrl, type ActionName, type Capabilities } from '@browserforge/browser-protocol';
import { api, browserKind, browserVersion, isFirefox } from './browser-api.js';
import { detachAll, setCdpEmitter, syncCdp } from './cdp.js';
import { bodyCaptureAvailable, ensureBodyFiltering, registerCaptureListeners, setEmitter, setServerUrl } from './capture.js';
import type { ContentCall, ContentReply } from './messages.js';
import { activity, clearApprovalHistory, getSettings, hostOf, loadApprovalHistory, loadSettings, logActivity, pendingApprovals, recordApproval, runtime, safeUrl, saveSettings, type ApprovalRecord } from './state.js';

declare const __E2E__: boolean; // true only in the -e2e test builds (dead-stripped from release builds)

z.config({ jitless: true }); // extension CSP forbids eval-based schema compilation

const EXT_VERSION = '0.1.0';
const APPROVAL_TIMEOUT_MS = 120_000;
const RESTRICTED_HOST = /^(addons\.mozilla\.org|chromewebstore\.google\.com|chrome\.google\.com)$/i;

class ActionError extends Error {
  constructor(public code: string, message: string, public retryable = false, public details?: Record<string, unknown>) {
    super(message);
  }
}

// ---------- WebSocket link to the local server ----------
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let backoff = 1000;
let wantConnected = false;
const inflight = new Map<string, AbortController>();
const responseCache = new Map<string, unknown>();
const outbox: unknown[] = [];

function capabilities(): Capabilities {
  return {
    networkCapture: true,
    responseBodies: true, // available after the user grants the optional permission
    webSocketFrames: !isFirefox, // Chrome via the optional debugger permission
    screenshots: true,
    fullPageScreenshots: true,
    downloads: true,
  };
}

function send(msg: unknown, queueIfDown = false): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  else if (queueIfDown) {
    outbox.push(msg);
    if (outbox.length > 200) outbox.shift();
  }
}
setEmitter((m) => send(m));

function emitActivity(item: Parameters<typeof logActivity>[0]): void {
  const a = logActivity(item);
  send({ v: PROTOCOL_VERSION, type: 'event', event: 'activity', data: { at: a.at, action: a.action, summary: a.summary, tabId: a.tabId, outcome: a.outcome } });
}

export function connect(): void {
  const s = getSettings();
  wantConnected = true;
  if (!s.token) {
    runtime.lastError = 'No token configured';
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  let url: URL;
  try {
    url = new URL(s.serverUrl);
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('bad');
  } catch {
    runtime.lastError = 'Server URL must be ws://127.0.0.1:<port>/ext (loopback only)';
    return;
  }
  setServerUrl(s.serverUrl);
  setCdpEmitter((m) => send(m), s.serverUrl.replace(/^ws/, 'http'));
  runtime.connecting = true;
  runtime.lastError = '';
  const sock = new WebSocket(url.toString());
  ws = sock;
  sock.onopen = () => {
    sock.send(
      JSON.stringify({
        v: PROTOCOL_VERSION, type: 'hello', token: s.token,
        browser: { kind: browserKind, version: browserVersion(), id: s.browserId },
        extension: { id: api.runtime.id, version: EXT_VERSION },
        capabilities: capabilities(),
      }),
    );
  };
  sock.onmessage = (ev) => {
    let json: unknown;
    try {
      json = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    const ack = HelloAckSchema.safeParse(json);
    if (ack.success) {
      runtime.connected = true;
      runtime.connecting = false;
      backoff = 1000;
      updateBadge();
      // Flush responses produced while disconnected.
      for (const m of outbox.splice(0)) send(m);
      return;
    }
    void onServerMessage(json);
  };
  sock.onclose = (ev) => {
    if (ws === sock) ws = null;
    runtime.connected = false;
    runtime.connecting = false;
    if (ev.code === 4401) {
      runtime.lastError = 'Server rejected the token';
      wantConnected = false;
    } else if (ev.code === 1006 || !runtime.lastError) runtime.lastError = 'Disconnected';
    updateBadge();
    if (wantConnected) {
      reconnectTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15_000);
    }
  };
  sock.onerror = () => {
    runtime.lastError = 'Cannot reach server (is `browserforge serve` running?)';
  };
}

export function disconnect(): void {
  wantConnected = false;
  clearTimeout(reconnectTimer);
  ws?.close(1000, 'user disconnect');
  ws = null;
  runtime.connected = false;
  updateBadge();
}

async function onServerMessage(json: unknown): Promise<void> {
  const cancel = CancelSchema.safeParse(json);
  if (cancel.success) {
    inflight.get(cancel.data.id)?.abort();
    return;
  }
  const req = RequestSchema.safeParse(json);
  if (!req.success) return;
  const { id, action, args, timeoutMs } = req.data;
  // Duplicate delivery (e.g. after reconnect): answer from cache or ignore if still running.
  if (responseCache.has(id)) return send(responseCache.get(id), true);
  if (inflight.has(id)) return;
  const ctrl = new AbortController();
  inflight.set(id, ctrl);
  const respond = (msg: unknown) => {
    responseCache.set(id, msg);
    if (responseCache.size > 200) responseCache.delete(responseCache.keys().next().value as string);
    inflight.delete(id);
    send(msg, true);
  };
  try {
    const result = await withTimeout(runAction(action, args, ctrl.signal), timeoutMs ?? 30_000, ctrl);
    respond({ v: PROTOCOL_VERSION, type: 'response', id, ok: true, result });
  } catch (e) {
    const err = normalizeError(e, ctrl.signal);
    emitActivity({ action, summary: `${err.code}: ${err.message}`.slice(0, 200), outcome: err.code === 'APPROVAL_DENIED' ? 'denied' : 'error' });
    respond({ v: PROTOCOL_VERSION, type: 'response', id, ok: false, error: { code: err.code, message: err.message, retryable: err.retryable, details: err.details } });
  }
}

function normalizeError(e: unknown, signal: AbortSignal): ActionError {
  if (e instanceof ActionError) return e;
  if (signal.aborted) return new ActionError(runtime.paused && runtime.humanLocked ? 'STOPPED' : 'CANCELLED', 'Cancelled');
  return new ActionError('INTERNAL', e instanceof Error ? e.message.slice(0, 300) : 'Unexpected error');
}

function withTimeout<T>(p: Promise<T>, ms: number, ctrl: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      ctrl.abort();
      reject(new ActionError('TIMEOUT', `Action exceeded ${ms}ms`, true));
    }, ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// ---------- tabs ----------
async function activeTab(): Promise<chrome.tabs.Tab> {
  // Our own approval popup takes focus while a request waits; it (or any non-normal window) must not be mistaken for the page the agent works on.
  if (runtime.lastNormalWindowId !== null) {
    const [t] = await api.tabs.query({ active: true, windowId: runtime.lastNormalWindowId }).catch(() => []);
    if (t) return t;
  }
  const [t] = await api.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' } as chrome.tabs.QueryInfo);
  if (t) return t;
  const [any] = await api.tabs.query({ active: true, windowType: 'normal' } as chrome.tabs.QueryInfo);
  if (!any) throw new ActionError('TAB_NOT_FOUND', 'No active tab');
  return any;
}
api.windows.onFocusChanged.addListener((id) => {
  if (id === api.windows.WINDOW_ID_NONE) return;
  void api.windows.get(id).then((w) => { if (w.type === 'normal') runtime.lastNormalWindowId = id; }).catch(() => undefined);
});

async function targetTab(tabId?: number): Promise<chrome.tabs.Tab> {
  const id = tabId ?? runtime.selectedTabId ?? undefined;
  if (id === undefined) return activeTab();
  try {
    return await api.tabs.get(id);
  } catch {
    if (tabId === undefined) {
      runtime.selectedTabId = null;
      return activeTab();
    }
    throw new ActionError('TAB_NOT_FOUND', `Tab ${id} does not exist`);
  }
}

function tabInfo(t: chrome.tabs.Tab) {
  return { tabId: t.id, windowId: t.windowId, active: t.active, title: (t.title ?? '').slice(0, 200), url: t.url ?? '', status: t.status, incognito: t.incognito || undefined, selected: t.id === runtime.selectedTabId || undefined };
}

function assertScriptable(t: chrome.tabs.Tab): void {
  const url = t.url ?? '';
  if (!/^https?:/i.test(url)) throw new ActionError('UNSUPPORTED', `This page (${url.split(':')[0] || 'blank'}:) is a browser-internal page; extensions cannot access it`);
  if (RESTRICTED_HOST.test(hostOf(url))) throw new ActionError('UNSUPPORTED', 'The browser blocks extensions on this site');
}

/**
 * Resolves when the tab finishes loading. Call it BEFORE starting the navigation so the `loading` event cannot be missed;
 * `prevUrl` additionally lets same-document navigations (hash changes, history.pushState) finish, since they never emit `loading`.
 */
function waitForComplete(tabId: number, timeoutMs: number, signal: AbortSignal, ignoreCurrent: boolean, prevUrl?: string): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    let sawLoading = !ignoreCurrent;
    const done = (fn: () => void) => {
      clearTimeout(timer);
      clearInterval(poll);
      api.tabs.onUpdated.removeListener(listener);
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const listener = (id: number, info: { status?: string }, tab: chrome.tabs.Tab) => {
      if (id !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && sawLoading) done(() => resolve(tab));
    };
    const onAbort = () => done(() => reject(new ActionError('CANCELLED', 'Cancelled')));
    const timer = setTimeout(() => done(() => reject(new ActionError('TIMEOUT', `Page did not finish loading within ${timeoutMs}ms`, true))), timeoutMs);
    api.tabs.onUpdated.addListener(listener);
    signal.addEventListener('abort', onAbort, { once: true });
    // Fallback: the load may have finished before we looked, or the navigation never leaves the document.
    const poll = setInterval(() => {
      void api.tabs.get(tabId).then((t) => {
        if (t.status === 'complete' && (sawLoading || (prevUrl !== undefined && t.url !== prevUrl))) done(() => resolve(t));
      }).catch(() => undefined);
    }, 250);
  });
}

// ---------- content script bridge ----------
const injected = new Set<number>(); // tabs whose current document already answered a ping
api.tabs.onUpdated.addListener((id, info) => { if (info.status === 'loading') injected.delete(id); });
api.tabs.onRemoved.addListener((id) => injected.delete(id));

async function ensureContent(tab: chrome.tabs.Tab): Promise<void> {
  const id = tab.id!;
  if (injected.has(id)) return;
  try {
    await api.tabs.sendMessage(id, { kind: 'bf-call', op: 'ping', args: {} } satisfies ContentCall);
    injected.add(id);
    return;
  } catch {
    /* not injected yet (page loaded before the extension) */
  }
  try {
    await api.scripting.executeScript({ target: { tabId: id }, files: ['content.js'] });
    injected.add(id);
  } catch {
    throw new ActionError('UNSUPPORTED', 'Cannot inject into this page (restricted by the browser)');
  }
}

async function callContent(tab: chrome.tabs.Tab, op: string, args: Record<string, unknown>, signal: AbortSignal, approved = false): Promise<unknown> {
  assertScriptable(tab);
  await ensureContent(tab);
  signal.throwIfAborted();
  let reply: ContentReply;
  try {
    reply = (await api.tabs.sendMessage(tab.id!, { kind: 'bf-call', op, args, approved } satisfies ContentCall)) as ContentReply;
  } catch {
    injected.delete(tab.id!);
    throw new ActionError('NAVIGATION_FAILED', 'The page changed or closed while the action ran', true);
  }
  if (reply?.needsApproval && !approved) {
    const ok = await askApproval(reply.needsApproval.title, reply.needsApproval.detail, hostOf(tab.url), signal);
    if (!ok) throw new ActionError('APPROVAL_DENIED', 'The human denied this action');
    assertRunnable();
    return callContent(tab, op, args, signal, true);
  }
  if (!reply?.ok) {
    const e = reply?.error ?? { code: 'INTERNAL', message: 'No reply from page' };
    throw new ActionError(e.code, e.message, false, e.details);
  }
  return reply.result;
}

// ---------- approvals ----------
function askApproval(title: string, detail: string, host: string, signal: AbortSignal, timeoutMs = APPROVAL_TIMEOUT_MS): Promise<boolean> {
  const requestedAt = Date.now();
  const record = (id: string, outcome: ApprovalRecord['outcome'], by: ApprovalRecord['by']) =>
    void recordApproval({ id, requestedAt, decidedAt: Date.now(), title: title.slice(0, 120), detail: detail.slice(0, 500), host, outcome, by });
  // YOLO: a human switched this on in the popup. Everything passes, but it is still logged.
  if (getSettings().yolo) {
    record(crypto.randomUUID(), 'approved', 'yolo');
    emitActivity({ action: 'approval', summary: `Auto-approved (YOLO): ${title}`.slice(0, 200), outcome: 'ok' });
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve, reject) => {
    const id = crypto.randomUUID();
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      pendingApprovals.delete(id);
      updateBadge();
      if (pendingApprovals.size === 0) void closeApprovalWindow();
    };
    const finish = (v: boolean, outcome: ApprovalRecord['outcome'] = v ? 'approved' : 'denied') => {
      cleanup();
      record(id, outcome, outcome === 'timeout' || outcome === 'cancelled' ? 'system' : 'human');
      resolve(v);
    };
    const onAbort = () => {
      cleanup();
      record(id, 'cancelled', 'system');
      reject(new ActionError('CANCELLED', 'Cancelled while waiting for approval'));
    };
    const timer = setTimeout(() => {
      emitActivity({ action: 'approval', summary: `Timed out: ${title}`.slice(0, 200), outcome: 'denied' });
      finish(false, 'timeout');
    }, timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    pendingApprovals.set(id, { id, title: title.slice(0, 120), detail: detail.slice(0, 500), host, createdAt: requestedAt, resolve: (v: boolean) => finish(v) });
    emitActivity({ action: 'approval', summary: `Waiting for approval: ${title}`.slice(0, 200), outcome: 'pending' });
    updateBadge();
    void openApprovalWindow();
  });
}

/** A real window (not the toolbar popup, which cannot be opened without a user gesture) so approvals cannot be missed. */
async function openApprovalWindow(): Promise<void> {
  try {
    if (runtime.approvalWindowId !== null) {
      await api.windows.update(runtime.approvalWindowId, { focused: true, drawAttention: true });
      return;
    }
    const w = await api.windows.create({ url: api.runtime.getURL('approve.html'), type: 'popup', width: 460, height: 380, focused: true });
    runtime.approvalWindowId = w?.id ?? null;
  } catch {
    runtime.approvalWindowId = null; // window vanished or could not be created; the badge still signals it
  }
}
async function closeApprovalWindow(): Promise<void> {
  const id = runtime.approvalWindowId;
  runtime.approvalWindowId = null;
  if (id === null) return;
  try {
    await api.windows.remove(id);
  } catch {
    /* already closed */
  }
}
api.windows.onRemoved.addListener((id) => {
  if (id === runtime.approvalWindowId) runtime.approvalWindowId = null;
});

export function decideApproval(id: string, approved: boolean): void {
  const p = pendingApprovals.get(id);
  if (!p) return;
  emitActivity({ action: 'approval', summary: `${approved ? 'Approved' : 'Denied'}: ${p.title}`.slice(0, 200), outcome: approved ? 'ok' : 'denied' });
  p.resolve(approved);
}

function updateBadge(): void {
  const n = pendingApprovals.size;
  const yolo = getSettings().yolo;
  const text = n > 0 ? String(n) : yolo ? 'YOLO' : runtime.paused ? '❚❚' : runtime.connected ? '' : '!';
  const color = n > 0 ? '#d97706' : yolo ? '#dc2626' : runtime.paused ? '#6b7280' : runtime.connected ? '#16a34a' : '#dc2626';
  try {
    void (api.action as any).setBadgeText({ text });
    void (api.action as any).setBadgeBackgroundColor({ color });
  } catch {
    /* ignore */
  }
}

// ---------- pause / stop ----------
function assertRunnable(): void {
  if (runtime.paused) throw new ActionError(runtime.humanLocked ? 'STOPPED' : 'PAUSED', runtime.humanLocked ? 'The human stopped automation. It can only be resumed from the extension popup.' : 'Automation is paused');
}

export function stopAll(byHuman: boolean): void {
  runtime.paused = true;
  runtime.humanLocked = byHuman || runtime.humanLocked;
  for (const c of inflight.values()) c.abort();
  for (const p of [...pendingApprovals.values()]) p.resolve(false);
  emitActivity({ action: 'stop', summary: byHuman ? 'Stopped by the human' : 'Stopped by the agent', outcome: 'ok' });
  updateBadge();
}

export function setPaused(paused: boolean, byHuman: boolean): void {
  if (!paused) {
    if (runtime.humanLocked && !byHuman) throw new ActionError('PERMISSION_DENIED', 'The human stopped automation; only the extension popup can resume it');
    runtime.humanLocked = false;
  } else if (byHuman) runtime.humanLocked = true;
  runtime.paused = paused;
  emitActivity({ action: paused ? 'pause' : 'resume', summary: paused ? 'Automation paused' : 'Automation resumed', outcome: 'ok' });
  updateBadge();
}

// ---------- actions ----------
async function runAction(action: string, rawArgs: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  if (!isActionName(action)) throw new ActionError('UNSUPPORTED', `Unknown action ${action}`);
  const parsed = ACTIONS[action].args.safeParse(rawArgs);
  if (!parsed.success) throw new ActionError('INVALID_ARGUMENTS', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 300));
  const args = parsed.data as Record<string, any>;
  const control: ActionName[] = ['stop', 'pause', 'resume', 'status'];
  if (!control.includes(action)) assertRunnable();
  signal.throwIfAborted();

  switch (action) {
    case 'tabs_list': {
      const tabs = await api.tabs.query({});
      return { tabs: tabs.map(tabInfo) };
    }
    case 'tabs_active': return tabInfo(await targetTab());
    case 'tabs_select': {
      const t = await api.tabs.get(args.tabId).catch(() => { throw new ActionError('TAB_NOT_FOUND', `Tab ${args.tabId} does not exist`); });
      runtime.selectedTabId = t.id!;
      await api.tabs.update(t.id!, { active: true });
      emitActivity({ action, summary: `Selected tab ${t.id}`, tabId: t.id, outcome: 'ok' });
      return tabInfo(await api.tabs.get(t.id!));
    }
    case 'navigate': return navigate(args, signal);
    case 'screenshot': return screenshot(args, signal);
    case 'downloads': return downloads(args.limit ?? 20);
    case 'stop': stopAll(false); return { stopped: true };
    case 'pause': setPaused(true, false); return { paused: true };
    case 'resume': setPaused(false, false); return { paused: false };
    case 'status':
      return { paused: runtime.paused, humanLocked: runtime.humanLocked, yolo: getSettings().yolo, capture: getSettings().capture, pendingApprovals: pendingApprovals.size, selectedTabId: runtime.selectedTabId, browser: browserKind, version: browserVersion(), bodyCaptureAvailable: await bodyCaptureAvailable() };
    case 'network_configure': return configureCapture(args);
    case 'request_approval': {
      const ok = await askApproval(args.title, args.detail ?? '', '', signal, Math.min(args.timeoutMs ?? APPROVAL_TIMEOUT_MS, 300_000));
      return { approved: ok };
    }
    default: {
      // Operations executed inside the page by the content script.
      const tab = await targetTab(args.tabId);
      const opMap: Partial<Record<ActionName, string>> = { page_text: 'page_text', dom_snapshot: 'dom_snapshot', interactive_elements: 'interactive_elements', forms: 'forms', click: 'click', type: 'type', fill_field: 'fill_field', select_option: 'select_option', scroll: 'scroll', press_key: 'press_key', wait_for_element: 'wait_for_element', fill_form: 'fill_form', console_errors: 'console_errors' };
      const op = opMap[action];
      if (!op) throw new ActionError('UNSUPPORTED', `Action ${action} is not implemented`);
      const { tabId: _t, ...rest } = args;
      const out = await callContent(tab, op, rest, signal);
      const mutating = !ACTIONS[action].readOnly;
      if (mutating) emitActivity({ action, summary: `${action} on ${hostOf(tab.url)}${args.ref ? ` (${args.ref})` : ''}`, tabId: tab.id, outcome: 'ok' });
      return out;
    }
  }
}

async function navigate(args: Record<string, any>, signal: AbortSignal): Promise<unknown> {
  const timeout = args.timeoutMs ?? 30_000;
  let tab: chrome.tabs.Tab;
  if (args.url !== undefined) {
    if (!isNavigableUrl(args.url)) throw new ActionError('INVALID_ARGUMENTS', 'Only http(s) URLs can be opened');
    if (args.newTab) {
      tab = await api.tabs.create({ url: args.url, active: true });
      runtime.selectedTabId = tab.id!;
      tab = await waitForComplete(tab.id!, timeout, signal, false, 'about:blank');
    } else {
      const t = await targetTab(args.tabId);
      const waiting = waitForComplete(t.id!, timeout, signal, true, t.url); // listener first, then navigate
      void waiting.catch(() => undefined);
      await api.tabs.update(t.id!, { url: args.url });
      tab = await waiting;
    }
  } else {
    const t = await targetTab(args.tabId);
    const waiting = waitForComplete(t.id!, timeout, signal, true, t.url);
    void waiting.catch(() => undefined);
    if (args.history === 'back') await (api.tabs as any).goBack(t.id);
    else if (args.history === 'forward') await (api.tabs as any).goForward(t.id);
    else await api.tabs.reload(t.id!);
    tab = await waiting;
  }
  if (/^(about:(neterror|certerror|blocked)|chrome-error:)/.test(tab.url ?? '')) throw new ActionError('NAVIGATION_FAILED', 'The browser could not load the page (network or certificate error)');
  emitActivity({ action: 'navigate', summary: `Navigate ${safeUrl(tab.url)}`, tabId: tab.id, outcome: 'ok' });
  return tabInfo(tab);
}

async function screenshot(args: Record<string, any>, signal: AbortSignal): Promise<unknown> {
  const tab = await targetTab(args.tabId);
  assertScriptable(tab);
  if (!tab.active) await api.tabs.update(tab.id!, { active: true });
  await new Promise((r) => setTimeout(r, 120));
  const format: 'png' | 'jpeg' = args.format ?? (args.fullPage ? 'jpeg' : 'png');
  const opts: any = { format, ...(format === 'jpeg' ? { quality: args.quality ?? 80 } : {}) };
  if (!args.fullPage) {
    const dataUrl: string = await (api.tabs as any).captureVisibleTab(tab.windowId, opts);
    return { mimeType: `image/${format}`, data: dataUrl.slice(dataUrl.indexOf(',') + 1) };
  }
  // Full page: scroll and stitch viewport captures.
  const m = (await callContent(tab, 'page_metrics', {}, signal)) as { width: number; height: number; scrollHeight: number; scrollY: number; dpr: number };
  const maxHeight = Math.min(m.scrollHeight, 12_000);
  const canvas = new OffscreenCanvas(Math.round(m.width * m.dpr), Math.round(maxHeight * m.dpr));
  const ctx = canvas.getContext('2d')!;
  try {
    for (let y = 0; y < maxHeight; y += m.height) {
      signal.throwIfAborted();
      await callContent(tab, 'scroll_to', { y }, signal);
      await new Promise((r) => setTimeout(r, 250)); // captureVisibleTab is rate limited (~2/s)
      const dataUrl: string = await (api.tabs as any).captureVisibleTab(tab.windowId, opts);
      const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
      ctx.drawImage(bmp, 0, Math.round(y * m.dpr));
      bmp.close();
    }
  } finally {
    await callContent(tab, 'scroll_to', { y: m.scrollY }, signal).catch(() => undefined);
  }
  const blob = await canvas.convertToBlob({ type: `image/${format}`, quality: (args.quality ?? 80) / 100 });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { mimeType: `image/${format}`, data: btoa(bin), width: canvas.width, height: canvas.height, note: m.scrollHeight > maxHeight ? 'Page truncated at 12000 CSS px; fixed headers may repeat in stitched captures' : 'Fixed headers may repeat in stitched captures' };
}

async function downloads(limit: number): Promise<unknown> {
  const dl = (api as any).downloads;
  if (!dl || !(await api.permissions.contains({ permissions: ['downloads'] }))) {
    throw new ActionError('PERMISSION_DENIED', 'The optional "downloads" permission is not granted. Enable it in the BrowserForge popup.');
  }
  const items: any[] = await dl.search({ orderBy: ['-startTime'], limit });
  return {
    downloads: items.map((d) => ({ id: d.id, fileName: String(d.filename ?? '').split(/[\\/]/).pop(), host: hostOf(d.url), state: d.state, bytesReceived: d.bytesReceived, totalBytes: d.totalBytes, mime: d.mime, startTime: d.startTime, error: d.error })),
  };
}

async function configureCapture(args: Record<string, any>): Promise<unknown> {
  const s = getSettings();
  const cap = { ...s.capture };
  if (args.enabled !== undefined) cap.enabled = args.enabled;
  if (args.tabIds !== undefined) cap.tabIds = args.tabIds.length ? args.tabIds : null;
  if (args.maxBodyBytes !== undefined) cap.maxBodyBytes = args.maxBodyBytes;
  let note: string | undefined;
  if (args.captureBodies !== undefined) {
    if (args.captureBodies && !(await bodyCaptureAvailable())) {
      note = isFirefox
        ? 'Response bodies need the optional permissions "webRequestBlocking" and "webRequestFilterResponse". The human must enable them in the BrowserForge popup.'
        : 'Response bodies need the optional "debugger" permission. The human must enable it in the BrowserForge popup.';
      cap.captureBodies = false;
    } else {
      cap.captureBodies = args.captureBodies;
      if (cap.captureBodies) await ensureBodyFiltering();
    }
  }
  await saveSettings({ capture: cap });
  if (!isFirefox) await (cap.captureBodies && cap.enabled ? syncCdp() : detachAll());
  emitActivity({ action: 'network_configure', summary: `Capture ${cap.enabled ? 'on' : 'off'}, bodies ${cap.captureBodies ? 'on' : 'off'}`, outcome: 'ok' });
  return { capture: cap, note };
}

// ---------- popup bridge ----------
api.runtime.onMessage.addListener(((msg: any, sender: any, sendResponse: (r: unknown) => void) => {
  if (!msg || msg.kind !== 'bf-popup') return false;
  // Only our own extension pages (popup) may drive these controls; content scripts / web pages cannot.
  if (sender?.id !== api.runtime.id || (sender?.tab && !String(sender.url ?? '').startsWith(api.runtime.getURL('')))) return false;
  void (async () => {
    try {
      switch (msg.op) {
        case 'getState': {
          const s = getSettings();
          return sendResponse({ ok: true, state: {
            connected: runtime.connected, connecting: runtime.connecting, lastError: runtime.lastError, paused: runtime.paused, humanLocked: runtime.humanLocked,
            yolo: s.yolo, approvalSound: s.approvalSound, serverUrl: s.serverUrl, tokenSet: Boolean(s.token), autoConnect: s.autoConnect, capture: s.capture, browser: browserKind, selectedTabId: runtime.selectedTabId,
            pendingApprovals: [...pendingApprovals.values()].map(({ resolve: _r, ...p }) => p), activity: activity.slice(-80), bodyCaptureAvailable: await bodyCaptureAvailable(),
          } });
        }
        case 'saveSettings': {
          const patch: any = {};
          if (typeof msg.serverUrl === 'string') patch.serverUrl = msg.serverUrl.trim();
          if (typeof msg.token === 'string' && msg.token.trim()) patch.token = msg.token.trim();
          if (typeof msg.autoConnect === 'boolean') patch.autoConnect = msg.autoConnect;
          await saveSettings(patch);
          break;
        }
        case 'connect': disconnect(); backoff = 1000; await saveSettings({ autoConnect: true }); connect(); break;
        case 'disconnect': disconnect(); await saveSettings({ autoConnect: false }); break;
        case 'stop': stopAll(true); break;
        case 'pause': setPaused(true, true); break;
        case 'resume': setPaused(false, true); break;
        case 'setYolo': await saveSettings({ yolo: msg.on === true }); emitActivity({ action: 'yolo', summary: msg.on === true ? 'YOLO mode ON: all approvals auto-pass' : 'YOLO mode off', outcome: msg.on === true ? 'error' : 'ok' }); updateBadge(); break;
        case 'setSound': await saveSettings({ approvalSound: msg.on === true }); break;
        case 'getHistory': return sendResponse({ ok: true, history: await loadApprovalHistory() });
        case 'clearHistory': await clearApprovalHistory(); break;
        case 'approve': decideApproval(String(msg.id), msg.approved === true); break;
        case 'selectTab': runtime.selectedTabId = Number(msg.tabId); break;
        case 'setCapture': {
          const cap = { ...getSettings().capture };
          if (typeof msg.enabled === 'boolean') cap.enabled = msg.enabled;
          if (typeof msg.captureBodies === 'boolean') cap.captureBodies = msg.captureBodies;
          await saveSettings({ capture: cap });
          if (cap.captureBodies) await ensureBodyFiltering();
          if (!isFirefox) await (cap.captureBodies && cap.enabled ? syncCdp() : detachAll());
          break;
        }
        case 'permissionsChanged': await ensureBodyFiltering(); break;
        case 'clearActivity': activity.length = 0; break;
        default: return sendResponse({ ok: false, error: 'unknown op' });
      }
      updateBadge();
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: e instanceof ActionError ? e.message : 'failed' });
    }
  })();
  return true;
}) as never);

// ---------- lifecycle ----------
registerCaptureListeners();

api.tabs.onRemoved.addListener((id) => {
  if (runtime.selectedTabId === id) runtime.selectedTabId = null;
});

// Keep the connection alive: pings reset idle timers (Chrome service worker / Firefox event page) and detect dead sockets.
setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'ping' }));
    void api.runtime.getPlatformInfo();
  } else if (wantConnected) connect();
}, 15_000);
try {
  (api as any).alarms?.create('bf-keepalive', { periodInMinutes: 0.5 });
  (api as any).alarms?.onAlarm.addListener(() => {
    if (wantConnected && !(ws && ws.readyState <= 1)) connect();
  });
} catch {
  /* alarms permission absent */
}

void (async () => {
  let s = await loadSettings();
  if (__E2E__) {
    // Test builds read connection details from a bundled file so automation does not need the popup.
    try {
      const cfg = (await (await fetch(api.runtime.getURL('e2e-config.json'))).json()) as { serverUrl: string; token: string };
      await saveSettings({ serverUrl: cfg.serverUrl, token: cfg.token, autoConnect: true });
      s = getSettings();
    } catch {
      /* no config bundled */
    }
  }
  if (s.autoConnect && s.token) connect();
  if (s.capture.captureBodies) await ensureBodyFiltering();
  if (!isFirefox && s.capture.captureBodies && s.capture.enabled && s.token) void syncCdp();
  updateBadge();
  // Optional permissions granted later (popup request) enable body filtering without a restart.
  (api.permissions as any).onAdded?.addListener(() => void ensureBodyFiltering());
})();
