/* eslint-disable @typescript-eslint/no-explicit-any */
import { PROTOCOL_VERSION } from '@browserforge/browser-protocol';
import { api, isFirefox } from './browser-api.js';
import { cdpAttachedTabs } from './cdp.js';
import { getSettings, hostOf } from './state.js';

type Header = { name: string; value: string };

interface Rec {
  requestId: string;
  tabId: number;
  url: string;
  method: string;
  requestHeaders: Header[];
  requestBody?: string;
  requestBodyTruncated?: boolean;
  startedAt: number;
  resourceType?: string;
  initiator?: string;
  status?: number;
  statusText?: string;
  responseHeaders?: Header[];
  fromCache?: boolean;
  mimeType?: string;
  chunks?: Uint8Array[];
  chunkBytes?: number;
  bodyDone?: boolean;
  bodyTruncated?: boolean;
  completed?: boolean;
  error?: string;
  endedAt?: number;
}

let emit: (msg: unknown) => void = () => undefined;
let serverHost = '';
const recs = new Map<string, Rec>();
const TEXTUAL = /(json|text\/|xml|javascript|x-www-form-urlencoded|graphql)/i;

export function setEmitter(fn: (msg: unknown) => void): void {
  emit = fn;
}
export function setServerUrl(url: string): void {
  serverHost = hostOf(url.replace(/^ws/, 'http'));
}

function wanted(details: { tabId: number; url: string }): boolean {
  const s = getSettings().capture;
  if (!s.enabled || details.tabId < 0) return false;
  if (cdpAttachedTabs().has(details.tabId)) return false; // the debugger path already records this tab in full
  if (!/^https?:/i.test(details.url)) return false;
  if (serverHost && hostOf(details.url) === serverHost) return false; // never capture our own control channel
  if (s.tabIds && !s.tabIds.includes(details.tabId)) return false;
  return true;
}

function decodeBody(bytes: Uint8Array, max: number): { text: string; truncated: boolean } {
  const slice = bytes.length > max ? bytes.subarray(0, max) : bytes;
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(slice), truncated: bytes.length > max };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function prune(): void {
  const cutoff = Date.now() - 120_000;
  for (const [k, r] of recs) if (r.startedAt < cutoff) recs.delete(k);
}

function flush(r: Rec): void {
  if (!r.completed) return;
  const s = getSettings().capture;
  if (s.captureBodies && isFirefoxBodyExpected(r) && !r.bodyDone && Date.now() - (r.endedAt ?? 0) < 2000) {
    setTimeout(() => flush(r), 100);
    return;
  }
  recs.delete(r.requestId);
  let responseBody: string | undefined;
  if (r.chunks && r.chunkBytes) {
    const d = decodeBody(concat(r.chunks, r.chunkBytes), s.maxBodyBytes);
    responseBody = d.text;
    r.bodyTruncated = r.bodyTruncated || d.truncated;
  }
  emit({
    v: PROTOCOL_VERSION,
    type: 'event',
    event: 'network',
    data: {
      requestId: r.requestId,
      tabId: r.tabId,
      url: r.url,
      method: r.method,
      requestHeaders: r.requestHeaders,
      requestBody: r.requestBody,
      requestBodyTruncated: r.requestBodyTruncated,
      status: r.status,
      statusText: r.statusText,
      responseHeaders: r.responseHeaders ?? [],
      responseBody,
      responseBodyTruncated: r.bodyTruncated,
      mimeType: r.mimeType,
      resourceType: r.resourceType,
      initiator: r.initiator,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      fromCache: r.fromCache,
      error: r.error,
    },
  });
}
const isFirefoxBodyExpected = (r: Rec) => r.chunks !== undefined;

function mimeOf(headers: Header[] | undefined): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === 'content-type')?.value?.split(';')[0]?.trim();
}

function requestBodyOf(details: any, max: number): { text?: string; truncated?: boolean } {
  const rb = details.requestBody;
  if (!rb) return {};
  if (rb.formData) {
    const p = new URLSearchParams();
    for (const [k, vs] of Object.entries(rb.formData as Record<string, string[]>)) for (const v of vs) p.append(k, v);
    return { text: p.toString() };
  }
  if (rb.raw) {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (const part of rb.raw as { bytes?: ArrayBuffer }[]) {
      if (part.bytes) {
        const u = new Uint8Array(part.bytes);
        parts.push(u);
        total += u.length;
      }
    }
    if (!total) return {};
    const d = decodeBody(concat(parts, total), max);
    return { text: d.text, truncated: d.truncated };
  }
  return {};
}

/** Can this build ever get the body permission (is it declared as optional)? Chrome's default build cannot: see build.mjs. */
export function bodyCapturePossible(): boolean {
  const optional = ((api.runtime.getManifest() as { optional_permissions?: string[] }).optional_permissions ?? []);
  return optional.includes(isFirefox ? 'webRequestFilterResponse' : 'debugger');
}

/** Whether the optional response-body permission is currently available. */
export async function bodyCaptureAvailable(): Promise<boolean> {
  try {
    if (isFirefox) return await (api.permissions as any).contains({ permissions: ['webRequestBlocking', 'webRequestFilterResponse'] });
    return await (api.permissions as any).contains({ permissions: ['debugger'] });
  } catch {
    return false;
  }
}

let blockingRegistered = false;

/** Firefox only: attach response filters. Needs the optional webRequestBlocking + webRequestFilterResponse permissions. */
export async function ensureBodyFiltering(): Promise<boolean> {
  if (!isFirefox) return false;
  if (blockingRegistered) return true;
  if (!(await bodyCaptureAvailable())) return false;
  const wr = api.webRequest as any;
  wr.onBeforeRequest.addListener(
    (d: any) => {
      const s = getSettings().capture;
      const r = recs.get(String(d.requestId));
      if (!r || !s.captureBodies || typeof wr.filterResponseData !== 'function') return undefined;
      try {
        const f = wr.filterResponseData(d.requestId);
        r.chunks = [];
        r.chunkBytes = 0;
        f.ondata = (ev: { data: ArrayBuffer }) => {
          if ((r.chunkBytes ?? 0) < s.maxBodyBytes) {
            const u = new Uint8Array(ev.data.slice(0));
            r.chunks!.push(u);
            r.chunkBytes = (r.chunkBytes ?? 0) + u.length;
          } else r.bodyTruncated = true;
          f.write(ev.data);
        };
        f.onstop = () => {
          r.bodyDone = true;
          f.disconnect();
        };
        f.onerror = () => {
          r.bodyDone = true;
        };
      } catch {
        /* request not filterable */
      }
      return undefined;
    },
    { urls: ['http://*/*', 'https://*/*'] },
    ['blocking'],
  );
  blockingRegistered = true;
  return true;
}

export function registerCaptureListeners(): void {
  const wr = api.webRequest as any;
  const filter = { urls: ['http://*/*', 'https://*/*'] };

  const beforeSpec = ['requestBody'];
  wr.onBeforeRequest.addListener(
    (d: any) => {
      if (!wanted(d)) return undefined;
      const s = getSettings().capture;
      const body = requestBodyOf(d, s.maxBodyBytes);
      const rec: Rec = {
        requestId: String(d.requestId), tabId: d.tabId, url: d.url, method: d.method, requestHeaders: [],
        requestBody: body.text, requestBodyTruncated: body.truncated, startedAt: Math.round(d.timeStamp ?? Date.now()),
        resourceType: d.type, initiator: d.originUrl ?? d.initiator ?? d.documentUrl,
      };
      recs.set(rec.requestId, rec);
      if (recs.size > 2000) prune();
      return undefined;
    },
    filter,
    beforeSpec,
  );

  const hdrSpec = isFirefox ? ['requestHeaders'] : ['requestHeaders', 'extraHeaders'];
  wr.onBeforeSendHeaders.addListener(
    (d: any) => {
      const r = recs.get(String(d.requestId));
      if (r) r.requestHeaders = (d.requestHeaders ?? []).map((h: any) => ({ name: h.name, value: h.value ?? '' }));
      return undefined;
    },
    filter,
    hdrSpec,
  );

  const respSpec = isFirefox ? ['responseHeaders'] : ['responseHeaders', 'extraHeaders'];
  wr.onCompleted.addListener(
    (d: any) => {
      const r = recs.get(String(d.requestId));
      if (!r) return;
      r.status = d.statusCode;
      r.statusText = d.statusLine?.split(' ').slice(2).join(' ') || undefined;
      r.responseHeaders = (d.responseHeaders ?? []).map((h: any) => ({ name: h.name, value: h.value ?? '' }));
      r.mimeType = mimeOf(r.responseHeaders);
      r.fromCache = d.fromCache;
      r.endedAt = Math.round(d.timeStamp ?? Date.now());
      r.completed = true;
      if (r.chunks && r.mimeType && !TEXTUAL.test(r.mimeType)) {
        r.chunks = undefined; // binary: don't keep it
        r.chunkBytes = 0;
      }
      flush(r);
    },
    filter,
    respSpec,
  );
  wr.onErrorOccurred.addListener(
    (d: any) => {
      const r = recs.get(String(d.requestId));
      if (!r) return;
      r.error = String(d.error ?? 'error').slice(0, 200);
      r.endedAt = Math.round(d.timeStamp ?? Date.now());
      r.completed = true;
      r.bodyDone = true;
      flush(r);
    },
    filter,
  );
}
