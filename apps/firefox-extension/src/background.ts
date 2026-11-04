/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from 'zod';
import { ACTIONS, HelloAckSchema, PROTOCOL_VERSION, RequestSchema, CancelSchema, isActionName, isNavigableUrl, type ActionName, type Capabilities } from '@browserforge/browser-protocol';
import { api, browserKind, browserVersion, isFirefox } from './browser-api.js';
import { detachAll, setCdpEmitter, syncCdp } from './cdp.js';
import { bodyCaptureAvailable, bodyCapturePossible, ensureBodyFiltering, registerCaptureListeners, setEmitter, setServerUrl } from './capture.js';
import type { ContentCall, ContentReply } from './messages.js';
import { activity, clearActivity, clearApprovalHistory, getSettings, hostOf, loadActivity, loadApprovalHistory, loadSettings, logActivity, pendingApprovals, recordApproval, runtime, safeUrl, saveSettings, type ApprovalRecord } from './state.js';

declare const __E2E__: boolean; // true only in the -e2e test builds (dead-stripped from release builds)

z.config({ jitless: true }); // extension CSP forbids eval-based schema compilation

const EXT_VERSION = '0.2.1';
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

/** The agent window if it is still open (the person may have closed it). */
async function liveAgentWindow(): Promise<chrome.windows.Window | null> {
  if (runtime.agentWindowId === null) return null;
  try {
    return await api.windows.get(runtime.agentWindowId, { populate: true });
  } catch {
    runtime.agentWindowId = null;
    return null;
  }
}

/** Open the agent's own window (without stealing focus), showing `url`. Its first tab belongs to the agent. */
async function openAgentWindow(url: string): Promise<chrome.tabs.Tab> {
  const w = await api.windows.create({ url, type: 'normal', focused: false });
  runtime.agentWindowId = w?.id ?? null;
  const tab = w?.tabs?.[0];
  if (!tab?.id) throw new ActionError('INTERNAL', 'Could not open the agent window');
  agentTabs.add(tab.id);
  runtime.selectedTabId = tab.id;
  emitActivity({ action: 'agent_window', summary: 'Opened the agent window', tabId: tab.id, outcome: 'ok' });
  return tab;
}

async function targetTab(tabId?: number): Promise<chrome.tabs.Tab> {
  const id = tabId ?? runtime.selectedTabId ?? undefined;
  if (id !== undefined) {
    try {
      return await api.tabs.get(id);
    } catch {
      if (tabId !== undefined) throw new ActionError('TAB_NOT_FOUND', `Tab ${id} does not exist`);
      runtime.selectedTabId = null;
    }
  }
  if (getSettings().agentWindow) {
    // The agent never reaches into the tabs the person is using unless it picked one on purpose (browser_select_tab or a tabId).
    const w = await liveAgentWindow();
    const t = w?.tabs?.find((x) => x.active) ?? w?.tabs?.[0];
    if (t) return t;
    throw new ActionError('TAB_NOT_FOUND', 'The agent window has no tab yet. Open a page with browser_navigate (that opens the agent window), or choose one of the user\'s tabs with browser_select_tab.');
  }
  return activeTab();
}

function tabInfo(t: chrome.tabs.Tab) {
  return { tabId: t.id, windowId: t.windowId, active: t.active, title: (t.title ?? '').slice(0, 200), url: t.url ?? '', status: t.status, incognito: t.incognito || undefined, selected: t.id === runtime.selectedTabId || undefined, agent: agentTabs.has(t.id!) || undefined, inAgentWindow: (runtime.agentWindowId !== null && t.windowId === runtime.agentWindowId) || undefined };
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
/** Tabs the agent opened itself: it may close these without asking. */
const agentTabs = new Set<number>();
const injected = new Set<number>(); // tabs whose current document already answered a ping
api.tabs.onUpdated.addListener((id, info) => { if (info.status === 'loading') injected.delete(id); });
api.tabs.onRemoved.addListener((id) => { injected.delete(id); agentTabs.delete(id); });
// A page the agent opened may open more (an "Apply" link with target=_blank): those are the agent's to tidy up too.
api.tabs.onCreated.addListener((t) => { if (t.id !== undefined && t.openerTabId !== undefined && agentTabs.has(t.openerTabId)) agentTabs.add(t.id); });

async function ensureContent(tab: chrome.tabs.Tab, frameId = 0): Promise<void> {
  const id = tab.id!;
  if (frameId === 0 && injected.has(id)) return;
  try {
    await api.tabs.sendMessage(id, { kind: 'bf-call', op: 'ping', args: {} } satisfies ContentCall, { frameId });
    if (frameId === 0) injected.add(id);
    return;
  } catch {
    /* not injected yet (page loaded before the extension, or a frame we have not touched) */
  }
  try {
    await api.scripting.executeScript({ target: frameId === 0 ? { tabId: id } : { tabId: id, frameIds: [frameId] }, files: ['content.js'] });
    if (frameId === 0) injected.add(id);
  } catch {
    if (frameId !== 0) throw new ActionError('STALE_REF', 'The frame that owned this element is gone or cannot be scripted; call browser_get_interactive_elements again');
    throw new ActionError('UNSUPPORTED', 'Cannot inject into this page (restricted by the browser)');
  }
}

async function callContent(tab: chrome.tabs.Tab, op: string, args: Record<string, unknown>, signal: AbortSignal, approved = false, frameId = 0): Promise<unknown> {
  assertScriptable(tab);
  await ensureContent(tab, frameId);
  signal.throwIfAborted();
  let reply: ContentReply;
  try {
    reply = (await api.tabs.sendMessage(tab.id!, { kind: 'bf-call', op, args, approved } satisfies ContentCall, { frameId })) as ContentReply;
  } catch {
    injected.delete(tab.id!);
    throw new ActionError('NAVIGATION_FAILED', 'The page changed or closed while the action ran', true);
  }
  if (reply?.needsApproval && !approved) {
    const ok = await askApproval(reply.needsApproval.title, reply.needsApproval.detail, hostOf(tab.url), signal);
    if (!ok) throw new ActionError('APPROVAL_DENIED', 'The human denied this action');
    assertRunnable();
    return callContent(tab, op, args, signal, true, frameId);
  }
  if (!reply?.ok) {
    const e = reply?.error ?? { code: 'INTERNAL', message: 'No reply from page' };
    throw new ActionError(e.code, e.message, false, e.details);
  }
  return reply.result;
}

// ---------- iframes ----------
// Content scripts are injected on demand into each frame we need. A ref is "<epoch>:<n>" where the epoch identifies the frame's
// content script, so we remember which frame owns which epoch and send ref-based calls straight there.
const MAX_FRAMES = 12;
const frameByEpoch = new Map<string, { tabId: number; frameId: number }>();
function rememberEpoch(epoch: unknown, tabId: number, frameId: number): void {
  if (typeof epoch !== 'string' || !epoch) return;
  if (frameByEpoch.size >= 500) frameByEpoch.delete(frameByEpoch.keys().next().value as string);
  frameByEpoch.set(epoch, { tabId, frameId });
}
/** Which frame should handle this call? The one that owns the ref it mentions, else the top frame. */
function frameFor(tabId: number, args: Record<string, unknown>): number {
  const files = Array.isArray(args.files) ? (args.files as { key?: unknown }[]).map((f) => f.key) : [];
  for (const k of [args.ref, args.formRef, ...files]) {
    if (typeof k !== 'string') continue;
    const hit = frameByEpoch.get(k.split(':')[0]!);
    if (hit && hit.tabId === tabId) return hit.frameId;
  }
  return 0;
}
async function childFrames(tabId: number): Promise<{ frameId: number; url: string }[]> {
  try {
    const res = await api.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => location.href });
    return res
      .map((r) => ({ frameId: r.frameId ?? 0, url: String(r.result ?? '') }))
      .filter((f) => f.frameId !== 0 && /^(https?:|about:blank$|about:srcdoc$)/.test(f.url))
      .slice(0, MAX_FRAMES);
  } catch {
    return [];
  }
}
const frameLabel = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.slice(0, 80);
  } catch {
    return url.slice(0, 40);
  }
};

type Json = Record<string, any>;
/** Run a read op in the top frame and every iframe, and merge the answers so the agent sees one page. */
async function callWithFrames(tab: chrome.tabs.Tab, op: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const { includeFrames, ...rest } = args;
  const top = (await callContent(tab, op, rest, signal)) as Json;
  rememberEpoch(top.epoch, tab.id!, 0);
  if (includeFrames === false) return top;
  const frames = await childFrames(tab.id!);
  if (!frames.length) return top;
  const found: { frameId: number; url: string; res: Json }[] = [];
  for (const f of frames) {
    signal.throwIfAborted();
    try {
      const res = (await callContent(tab, op, rest, signal, false, f.frameId)) as Json;
      rememberEpoch(res.epoch, tab.id!, f.frameId);
      found.push({ ...f, res });
    } catch {
      /* a frame we cannot script (sandboxed, gone): skip it */
    }
  }
  if (op === 'interactive_elements') {
    const limit = Number(rest.limit ?? (rest.format === 'table' ? 100 : 300));
    const frameInfo: Json[] = [];
    if (top.rows) {
      const rows: string[] = [...top.rows];
      for (const f of found) {
        const add: string[] = (f.res.rows ?? []).map((r: string, i: number) => r.replace(/^\d+/, String(rows.length + i + 1)));
        if (!add.length) continue;
        frameInfo.push({ frameId: f.frameId, url: frameLabel(f.url), controls: add.length });
        rows.push(...add.slice(0, Math.max(0, limit - rows.length)));
      }
      return { ...top, rows: rows.slice(0, limit), total: top.total + found.reduce((n, f) => n + (f.res.total ?? 0), 0), truncated: Boolean(top.truncated) || rows.length > limit, ...(frameInfo.length ? { frames: frameInfo } : {}) };
    }
    const elements: Json[] = [...(top.elements ?? [])];
    for (const f of found) {
      const add = (f.res.elements ?? []).map((e: Json) => ({ ...e, frame: f.frameId }));
      if (!add.length) continue;
      frameInfo.push({ frameId: f.frameId, url: frameLabel(f.url), controls: add.length });
      elements.push(...add);
    }
    return { ...top, elements: elements.slice(0, limit), total: elements.length, truncated: Boolean(top.truncated) || elements.length > limit, ...(frameInfo.length ? { frames: frameInfo } : {}) };
  }
  if (op === 'tables') {
    const tables: Json[] = [...(top.tables ?? [])];
    for (const f of found) for (const t of f.res.tables ?? []) tables.push({ ...t, frame: { frameId: f.frameId, url: frameLabel(f.url) } });
    return { ...top, tables: tables.map((t, i) => ({ ...t, index: i })) };
  }
  if (op === 'forms') {
    const forms: Json[] = [...(top.forms ?? [])];
    for (const f of found) forms.push(...(f.res.forms ?? []).map((x: Json) => ({ ...x, frame: { frameId: f.frameId, url: frameLabel(f.url) } })));
    return { ...top, forms };
  }
  if (op === 'page_text') {
    const max = Math.min(Number(rest.maxChars ?? 50_000), 200_000);
    let text: string = top.text ?? '';
    for (const f of found) if (f.res.text?.trim()) text += `\n\n--- iframe ${frameLabel(f.url)} ---\n${f.res.text}`;
    return { ...top, text: text.slice(0, max), truncated: Boolean(top.truncated) || text.length > max, totalChars: text.length };
  }
  return top;
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
  if (id === runtime.agentWindowId) {
    runtime.agentWindowId = null;
    emitActivity({ action: 'agent_window', summary: 'The agent window was closed', outcome: 'ok' });
  }
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
  const rec = getSettings().recordHuman;
  const text = n > 0 ? String(n) : yolo ? 'YOLO' : rec ? 'REC' : runtime.paused ? '❚❚' : runtime.connected ? '' : '!';
  const color = n > 0 ? '#d97706' : yolo || rec ? '#dc2626' : runtime.paused ? '#6b7280' : runtime.connected ? '#16a34a' : '#dc2626';
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
    case 'tabs_close': {
      const t = await api.tabs.get(args.tabId).catch(() => { throw new ActionError('TAB_NOT_FOUND', `Tab ${args.tabId} does not exist`); });
      const openedByAgent = agentTabs.has(t.id!);
      // The agent may tidy up after itself; closing one of the human's tabs could lose unsaved work, so that asks first.
      if (!openedByAgent) {
        const ok = await askApproval(`Close tab “${(t.title ?? '').slice(0, 60) || 'untitled'}”`, `Close a tab the agent did not open (${safeUrl(t.url) || 'browser page'}); anything unsaved in it is lost`, hostOf(t.url), signal);
        if (!ok) throw new ActionError('APPROVAL_DENIED', 'The human denied this action');
        assertRunnable();
      }
      await api.tabs.remove(t.id!);
      agentTabs.delete(t.id!);
      if (runtime.selectedTabId === t.id) runtime.selectedTabId = null;
      emitActivity({ action, summary: `Closed tab ${t.id} (${hostOf(t.url) || 'browser page'})`, tabId: t.id, outcome: 'ok' });
      return { closed: true, tabId: t.id, openedByAgent };
    }
    case 'navigate': return navigate(args, signal);
    case 'screenshot': return screenshot(args, signal);
    case 'downloads': return downloads(args.limit ?? 20);
    case 'stop': stopAll(false); return { stopped: true };
    case 'pause': setPaused(true, false); return { paused: true };
    case 'resume': setPaused(false, false); return { paused: false };
    case 'status':
      return { paused: runtime.paused, humanLocked: runtime.humanLocked, yolo: getSettings().yolo, capture: getSettings().capture, pendingApprovals: pendingApprovals.size, selectedTabId: runtime.selectedTabId, agentWindow: { enabled: getSettings().agentWindow, open: runtime.agentWindowId !== null }, browser: browserKind, version: browserVersion(), bodyCaptureAvailable: await bodyCaptureAvailable(), bodyCapturePossible: bodyCapturePossible() };
    case 'network_configure': return configureCapture(args);
    case 'request_approval': {
      const ok = await askApproval(args.title, args.detail ?? '', '', signal, Math.min(args.timeoutMs ?? APPROVAL_TIMEOUT_MS, 300_000));
      return { approved: ok };
    }
    default: {
      // Operations executed inside the page by the content script.
      const tab = await targetTab(args.tabId);
      const opMap: Partial<Record<ActionName, string>> = { page_text: 'page_text', dom_snapshot: 'dom_snapshot', captcha_scan: 'captcha_scan', interactive_elements: 'interactive_elements', forms: 'forms', tables: 'tables', resolve_locator: 'resolve_locator', click: 'click', type: 'type', fill_field: 'fill_field', select_option: 'select_option', scroll: 'scroll', press_key: 'press_key', wait_for_element: 'wait_for_element', fill_form: 'fill_form', console_errors: 'console_errors' };
      const op = opMap[action];
      if (!op) throw new ActionError('UNSUPPORTED', `Action ${action} is not implemented`);
      const { tabId: _t, ...rest } = args;
      let out: unknown;
      if (op === 'resolve_locator') {
        // A recorded step inside an iframe is looked up in that frame, and its ref is remembered so the next call is routed there.
        const { frameUrl, ...inner } = rest as { frameUrl?: string };
        let frameId = 0;
        if (typeof frameUrl === 'string' && frameUrl) {
          const frames = await childFrames(tab.id!);
          const bare = (u: string) => u.split(/[?#]/)[0];
          const hit = frames.find((f) => f.url === frameUrl) ?? frames.find((f) => f.url.split('#')[0] === frameUrl.split('#')[0]) ?? frames.find((f) => bare(f.url) === bare(frameUrl)); // tokens in the query change on every visit
          if (!hit) throw new ActionError('ELEMENT_NOT_FOUND', `The recorded iframe (${frameLabel(frameUrl)}) is not on this page`);
          frameId = hit.frameId;
        }
        const found = (await callContent(tab, op, inner, signal, false, frameId)) as Json;
        rememberEpoch(String(found.ref ?? '').split(':')[0], tab.id!, frameId);
        out = found;
      } else if (['interactive_elements', 'forms', 'page_text', 'tables'].includes(op)) out = await callWithFrames(tab, op, rest, signal);
      else out = await callContent(tab, op, rest, signal, false, frameFor(tab.id!, rest));
      // Frames only know their own address; the flow belongs to the page the tab is showing.
      if (out && typeof out === 'object' && Array.isArray((out as Json)._flow)) for (const part of (out as Json)._flow as Json[]) Object.assign(part, { pageUrl: tab.url, tabId: tab.id, openerTabId: tab.openerTabId, incognito: tab.incognito === true });
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
    // In agent-window mode a navigation with no tab chosen opens the agent's own window instead of taking over the tab the person is using.
    const noTarget = args.tabId === undefined && runtime.selectedTabId === null;
    const w = getSettings().agentWindow ? await liveAgentWindow() : null;
    const openInAgentWindow = getSettings().agentWindow && (args.newTab || (noTarget && !w?.tabs?.length));
    if (openInAgentWindow && !w) {
      tab = await openAgentWindow(args.url);
      tab = await waitForComplete(tab.id!, timeout, signal, false, 'about:blank');
    } else if (args.newTab) {
      tab = await api.tabs.create({ url: args.url, active: true, ...(openInAgentWindow && w ? { windowId: w.id } : {}) });
      runtime.selectedTabId = tab.id!;
      agentTabs.add(tab.id!);
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
        : 'Response bodies in Chrome need the "chrome-bodies" build of the extension (it holds the "debugger" permission, which Chrome does not allow as optional). The human must load apps/firefox-extension/dist/chrome-bodies instead of dist/chrome; see docs/INSTALL.md.';
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

// ---------- "Record me": what the person does is relayed from the page to the server ----------
let humanWindow: number[] = [];
api.runtime.onMessage.addListener(((msg: any, sender: any) => {
  if (!msg || msg.kind !== 'bf-human' || !sender?.tab || sender.id !== api.runtime.id) return false;
  const s = getSettings();
  // Defence in depth: the page script already checks, but the switch lives here and private windows are never recorded.
  if (!s.recordHuman || sender.tab.incognito || !runtime.connected) return false;
  const now = Date.now();
  humanWindow = humanWindow.filter((t) => now - t < 1000);
  if (humanWindow.length >= 25) return false; // a person is not that fast; this is a runaway page
  humanWindow.push(now);
  const d = msg.data ?? {};
  const cut = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : undefined);
  const locator: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.locator ?? {})) if (typeof v === 'string' && v && k.length <= 30) locator[k] = v.slice(0, 600);
  const table = Array.isArray(d.table) ? d.table.slice(0, 100).map((r: unknown) => String(r).slice(0, 200)) : undefined;
  const kind = ['click', 'fill', 'select', 'press', 'upload'].includes(d.kind) ? d.kind : undefined;
  // The server drops a browser that sends it too many malformed messages, so everything is clamped to the protocol's limits here.
  if (!kind || !cut(d.url, 4000)) return false;
  send({
    v: PROTOCOL_VERSION, type: 'event', event: 'human',
    data: {
      at: now, tabId: sender.tab.id, kind, url: cut(d.url, 4000), frameUrl: cut(d.frameUrl, 4000), locator, fieldLabel: cut(d.fieldLabel, 120), key: cut(d.key, 30),
      sensitive: d.sensitive === true || undefined, consequential: d.consequential === true || undefined, custom: d.custom === true || undefined,
      nth: Number.isInteger(d.nth) && d.nth >= 0 && d.nth <= 10000 ? d.nth : undefined,
      shadow: Array.isArray(d.shadow) && d.shadow.length ? d.shadow.slice(0, 8).map((x: unknown) => String(x).slice(0, 600)) : undefined,
      state: d.state === 'checked' || d.state === 'unchecked' ? d.state : undefined,
      row: Number.isInteger(d.row) && d.row > 0 && table && d.row <= table.length ? d.row : undefined, table: Number.isInteger(d.row) ? table : undefined,
      value: s.recordValues && d.sensitive !== true && kind !== 'upload' ? cut(d.value, 5000) : undefined,
      task: s.recordTask || undefined,
    },
  });
  return false;
}) as never);

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
            yolo: s.yolo, approvalSound: s.approvalSound, agentWindow: s.agentWindow, agentWindowOpen: runtime.agentWindowId !== null, recordHuman: s.recordHuman, recordValues: s.recordValues, recordTask: s.recordTask, serverUrl: s.serverUrl, tokenSet: Boolean(s.token), autoConnect: s.autoConnect, capture: s.capture, browser: browserKind, selectedTabId: runtime.selectedTabId,
            pendingApprovals: [...pendingApprovals.values()].map(({ resolve: _r, ...p }) => p), activity: activity.slice(-80), bodyCaptureAvailable: await bodyCaptureAvailable(), bodyCapturePossible: bodyCapturePossible(),
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
        case 'setAgentWindow': {
          await saveSettings({ agentWindow: msg.on === true });
          emitActivity({ action: 'agent_window', summary: msg.on === true ? 'Agent window mode ON: the agent works in its own window' : 'Agent window mode off', outcome: 'ok' });
          break;
        }
        case 'takeOver': {
          // STOP, then bring the agent's window to the front so the person can carry on by hand; only the popup can hand control back.
          stopAll(true);
          const w = await liveAgentWindow();
          if (w?.id !== undefined) await api.windows.update(w.id, { focused: true }).catch(() => undefined);
          emitActivity({ action: 'takeover', summary: 'You took over', outcome: 'ok' });
          break;
        }
        case 'askAgent': {
          // "Ask the agent": tell whichever agent is connected to work on the page the person is looking at. Nothing is done here; the agent decides and still needs approval for consequential steps.
          if (!runtime.connected) return sendResponse({ ok: false, error: 'Not connected to the server' });
          if (runtime.paused) return sendResponse({ ok: false, error: runtime.humanLocked ? 'Stopped: hand control back to the agent first' : 'Paused: resume first' });
          const t = await activeTab();
          if (t.id === undefined || !/^https?:/.test(t.url ?? '')) return sendResponse({ ok: false, error: 'Open a web page first' });
          const note = typeof msg.note === 'string' ? msg.note.trim().slice(0, 500) : '';
          send({ v: PROTOCOL_VERSION, type: 'event', event: 'ask', data: { at: Date.now(), tabId: t.id, url: (t.url ?? '').slice(0, 4000), title: (t.title ?? '').slice(0, 300) || undefined, note: note || undefined } });
          let host = '';
          try { host = new URL(t.url ?? '').host; } catch { /* keep empty */ }
          emitActivity({ action: 'ask_agent', summary: `You asked the agent to work on ${host || 'this page'}`, tabId: t.id, outcome: 'ok' });
          break;
        }
        case 'handBack': setPaused(false, true); emitActivity({ action: 'takeover', summary: 'You handed control back to the agent', outcome: 'ok' }); break;
        case 'closeAgentWindow': {
          if (runtime.agentWindowId !== null) await api.windows.remove(runtime.agentWindowId).catch(() => undefined);
          runtime.agentWindowId = null;
          break;
        }
        case 'setRecord': {
          const patch: Partial<ReturnType<typeof getSettings>> = {};
          if (typeof msg.on === 'boolean') patch.recordHuman = msg.on;
          if (typeof msg.values === 'boolean') patch.recordValues = msg.values;
          if (typeof msg.task === 'string') patch.recordTask = msg.task.trim().slice(0, 200);
          const was = getSettings().recordHuman;
          await saveSettings(patch);
          if (patch.recordHuman !== undefined && patch.recordHuman !== was) emitActivity({ action: 'record', summary: patch.recordHuman ? `Record me ON${getSettings().recordValues ? ' (typed values kept)' : ''}` : 'Record me off', outcome: 'ok' });
          break;
        }
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
        case 'clearActivity': clearActivity(); break;
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
  await loadActivity();
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
