/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Chrome-only, opt-in: full request/response capture through the DevTools protocol (chrome.debugger).
 * Requires the optional "debugger" permission. Chrome itself shows a "debugging this browser" banner while attached.
 * Gives response bodies, complete headers and WebSocket frames that webRequest cannot see.
 */
import { PROTOCOL_VERSION } from '@browserforge/browser-protocol';
import { api, isFirefox } from './browser-api.js';
import { getSettings, hostOf } from './state.js';

interface Rec {
  tabId: number;
  requestId: string;
  url: string;
  method: string;
  requestHeaders: { name: string; value: string }[];
  requestBody?: string;
  startedAt: number;
  startTs: number;
  resourceType?: string;
  initiator?: string;
  status?: number;
  statusText?: string;
  responseHeaders?: { name: string; value: string }[];
  mimeType?: string;
  fromCache?: boolean;
}
interface WsRec { url: string; startedAt: number; frames: string[]; bytes: number; status?: number }

const attached = new Set<number>();
const recs = new Map<string, Rec>();
const sockets = new Map<string, WsRec>();
const TEXTUAL = /(json|text\/|xml|javascript|x-www-form-urlencoded|graphql)/i;
let emit: (m: unknown) => void = () => undefined;
let serverHost = '';
let started = false;

export const cdpAttachedTabs = (): ReadonlySet<number> => attached;
export function setCdpEmitter(fn: (m: unknown) => void, serverUrl: string): void {
  emit = fn;
  serverHost = hostOf(serverUrl.replace(/^ws/, 'http'));
}

const dbg = () => (api as any).debugger as typeof chrome.debugger;
const toHeaders = (h: Record<string, string> | undefined) => Object.entries(h ?? {}).map(([name, value]) => ({ name, value: String(value) }));

async function attach(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  try {
    await dbg().attach({ tabId }, '1.3');
    await dbg().sendCommand({ tabId }, 'Network.enable', { maxPostDataSize: getSettings().capture.maxBodyBytes });
    attached.add(tabId);
  } catch {
    /* tab not debuggable (devtools open, restricted page) */
  }
}

async function detach(tabId: number): Promise<void> {
  if (!attached.delete(tabId)) return;
  try {
    await dbg().detach({ tabId });
  } catch {
    /* already detached */
  }
}

function shouldAttach(tab: chrome.tabs.Tab): boolean {
  const s = getSettings().capture;
  if (!s.enabled || !s.captureBodies || tab.id === undefined) return false;
  if (!/^https?:/i.test(tab.url ?? '')) return false;
  if (s.tabIds && !s.tabIds.includes(tab.id)) return false;
  return true;
}

/** Attach to / detach from tabs according to current settings. */
export async function syncCdp(): Promise<void> {
  if (isFirefox || !(dbg() as unknown)) return;
  if (!started) start();
  const tabs = await api.tabs.query({});
  for (const t of tabs) {
    if (shouldAttach(t)) await attach(t.id!);
    else if (t.id !== undefined && attached.has(t.id)) await detach(t.id);
  }
}

export async function detachAll(): Promise<void> {
  for (const id of [...attached]) await detach(id);
}

function start(): void {
  started = true;
  dbg().onEvent.addListener((src, method, params: any) => void onEvent(src.tabId!, method, params));
  dbg().onDetach.addListener((src) => {
    if (src.tabId !== undefined) attached.delete(src.tabId);
  });
  api.tabs.onUpdated.addListener((id, info, tab) => {
    if (info.status === 'loading' || info.url) if (shouldAttach(tab)) void attach(id);
  });
  api.tabs.onRemoved.addListener((id) => attached.delete(id));
}

async function onEvent(tabId: number, method: string, p: any): Promise<void> {
  const key = (id: string) => `${tabId}:${id}`;
  switch (method) {
    case 'Network.requestWillBeSent': {
      if (serverHost && hostOf(p.request.url) === serverHost) return;
      if (!/^https?:/i.test(p.request.url)) return;
      // A redirect re-uses the requestId: finish the previous hop first.
      const prev = recs.get(key(p.requestId));
      if (prev && p.redirectResponse) {
        prev.status = p.redirectResponse.status;
        prev.statusText = p.redirectResponse.statusText;
        prev.responseHeaders = toHeaders(p.redirectResponse.headers);
        finish(prev, undefined, p.timestamp);
      }
      recs.set(key(p.requestId), {
        tabId, requestId: p.requestId, url: p.request.url, method: p.request.method,
        requestHeaders: toHeaders(p.request.headers), requestBody: p.request.postData,
        startedAt: Math.round((p.wallTime ?? Date.now() / 1000) * 1000), startTs: p.timestamp,
        resourceType: String(p.type ?? '').toLowerCase() || undefined, initiator: p.initiator?.url ?? p.documentURL,
      });
      return;
    }
    case 'Network.requestWillBeSentExtraInfo': {
      const r = recs.get(key(p.requestId));
      if (r && p.headers) r.requestHeaders = toHeaders(p.headers);
      return;
    }
    case 'Network.responseReceived': {
      const r = recs.get(key(p.requestId));
      if (!r) return;
      r.status = p.response.status;
      r.statusText = p.response.statusText;
      r.responseHeaders = toHeaders(p.response.headers);
      r.mimeType = p.response.mimeType;
      r.fromCache = p.response.fromDiskCache || p.response.fromServiceWorker || undefined;
      return;
    }
    case 'Network.responseReceivedExtraInfo': {
      const r = recs.get(key(p.requestId));
      if (r && p.headers) r.responseHeaders = toHeaders(p.headers);
      return;
    }
    case 'Network.loadingFinished': {
      const r = recs.get(key(p.requestId));
      if (!r) return;
      recs.delete(key(p.requestId));
      let body: string | undefined;
      let truncated = false;
      if (r.mimeType && TEXTUAL.test(r.mimeType) && r.method !== 'HEAD' && r.status !== 204 && r.status !== 304) {
        try {
          const res: any = await dbg().sendCommand({ tabId }, 'Network.getResponseBody', { requestId: p.requestId });
          const text: string = res.base64Encoded ? new TextDecoder().decode(Uint8Array.from(atob(res.body), (c) => c.charCodeAt(0))) : res.body;
          const max = getSettings().capture.maxBodyBytes;
          truncated = text.length > max;
          body = truncated ? text.slice(0, max) : text;
        } catch {
          /* body evicted or not available (e.g. redirects) */
        }
      }
      finish(r, { body, truncated }, p.timestamp);
      return;
    }
    case 'Network.loadingFailed': {
      const r = recs.get(key(p.requestId));
      if (!r) return;
      recs.delete(key(p.requestId));
      finish(r, undefined, p.timestamp, String(p.errorText ?? 'failed'));
      return;
    }
    case 'Network.webSocketCreated':
      sockets.set(key(p.requestId), { url: p.url, startedAt: Date.now(), frames: [], bytes: 0 });
      return;
    case 'Network.webSocketHandshakeResponseReceived': {
      const w = sockets.get(key(p.requestId));
      if (w) w.status = p.response?.status;
      return;
    }
    case 'Network.webSocketFrameSent':
    case 'Network.webSocketFrameReceived': {
      const w = sockets.get(key(p.requestId));
      if (!w) return;
      const max = getSettings().capture.maxBodyBytes;
      if (w.bytes > max) return;
      const dir = method.endsWith('Sent') ? 'send' : 'recv';
      const payload = String(p.response?.payloadData ?? '').slice(0, 2000);
      w.frames.push(JSON.stringify({ dir, op: p.response?.opcode, data: p.response?.opcode === 1 ? payload : '[binary]' }));
      w.bytes += payload.length;
      return;
    }
    case 'Network.webSocketClosed': {
      const w = sockets.get(key(p.requestId));
      if (!w) return;
      sockets.delete(key(p.requestId));
      emit({
        v: PROTOCOL_VERSION, type: 'event', event: 'network',
        data: { requestId: `cdp:${tabId}:ws:${p.requestId}`, tabId, url: w.url, method: 'GET', requestHeaders: [], status: w.status ?? 101, responseHeaders: [], responseBody: w.frames.join('\n'), mimeType: 'application/x-websocket-frames', resourceType: 'websocket', startedAt: w.startedAt, endedAt: Date.now() },
      });
      return;
    }
  }
}

function finish(r: Rec, body: { body?: string; truncated: boolean } | undefined, endTs: number | undefined, error?: string): void {
  emit({
    v: PROTOCOL_VERSION, type: 'event', event: 'network',
    data: {
      requestId: `cdp:${r.tabId}:${r.requestId}:${r.startTs}`, tabId: r.tabId, url: r.url, method: r.method,
      requestHeaders: r.requestHeaders, requestBody: r.requestBody, status: r.status, statusText: r.statusText,
      responseHeaders: r.responseHeaders ?? [], responseBody: body?.body, responseBodyTruncated: body?.truncated || undefined,
      mimeType: r.mimeType, resourceType: r.resourceType, initiator: r.initiator, startedAt: r.startedAt,
      endedAt: endTs && r.startTs ? Math.round(r.startedAt + (endTs - r.startTs) * 1000) : undefined, fromCache: r.fromCache, error,
    },
  });
}
