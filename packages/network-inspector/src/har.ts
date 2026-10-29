import { z } from 'zod';
import { BrowserForgeError, LIMITS, redactBody, redactHeaders, redactUrl, type Header } from '@browserforge/shared';
import type { CapturedRequest } from './types.js';

const HeaderSchema = z.object({ name: z.string(), value: z.string().default('') });
const EntrySchema = z.object({
  startedDateTime: z.string(),
  time: z.number().optional(),
  _resourceType: z.string().optional(),
  _tabId: z.number().optional(),
  request: z.object({
    method: z.string(),
    url: z.string(),
    headers: z.array(HeaderSchema).default([]),
    postData: z.object({ mimeType: z.string().optional(), text: z.string().optional() }).optional(),
  }),
  response: z
    .object({
      status: z.number().default(0),
      statusText: z.string().default(''),
      headers: z.array(HeaderSchema).default([]),
      content: z.object({ mimeType: z.string().optional(), text: z.string().optional(), encoding: z.string().optional() }).optional(),
    })
    .optional(),
});
const HarSchema = z.object({ log: z.object({ entries: z.array(EntrySchema) }) });

export interface ExportOptions {
  /** Include unredacted secrets. Caller must have checked policy. */
  includeSensitive?: boolean;
  creator?: { name: string; version: string };
}

export function exportHar(requests: CapturedRequest[], opts: ExportOptions = {}): object {
  const raw = opts.includeSensitive === true;
  const hdr = (h: Header[]) => (raw ? h : redactHeaders(h));
  return {
    log: {
      version: '1.2',
      creator: opts.creator ?? { name: 'BrowserForge MCP', version: '0.1.0' },
      comment: raw ? 'Contains unredacted sensitive values' : 'Sensitive values redacted',
      entries: requests.map((r) => {
        const reqCt = r.requestHeaders.find((h) => h.name.toLowerCase() === 'content-type')?.value;
        const body = r.requestBody === undefined ? undefined : raw ? r.requestBody : redactBody(r.requestBody, reqCt);
        const resText = r.responseBody === undefined ? undefined : raw || r.responseBodyBase64 ? r.responseBody : redactBody(r.responseBody, r.mimeType);
        const url = raw ? r.url : redactUrl(r.url);
        let queryString: { name: string; value: string }[] = [];
        try {
          queryString = [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
        } catch { /* keep empty */ }
        return {
          startedDateTime: new Date(r.startedAt).toISOString(),
          time: r.durationMs ?? 0,
          _resourceType: r.resourceType,
          _tabId: r.tabId,
          request: {
            method: r.method,
            url,
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: hdr(r.requestHeaders),
            queryString,
            headersSize: -1,
            bodySize: body === undefined ? 0 : Buffer.byteLength(body),
            ...(body === undefined ? {} : { postData: { mimeType: reqCt ?? '', text: body } }),
          },
          response: {
            status: r.status ?? 0,
            statusText: r.statusText ?? '',
            httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: hdr(r.responseHeaders),
            content: { size: resText === undefined ? 0 : Buffer.byteLength(resText), mimeType: r.mimeType ?? '', ...(resText === undefined ? {} : { text: resText }), ...(r.responseBodyBase64 ? { encoding: 'base64' } : {}) },
            redirectURL: '',
            headersSize: -1,
            bodySize: -1,
          },
          cache: {},
          timings: { send: 0, wait: r.durationMs ?? 0, receive: 0 },
        };
      }),
    },
  };
}

/** Parse a HAR document into capture records (ids/captureId are assigned by the store). */
export function parseHar(input: string | object, maxEntries = LIMITS.maxCapturedRequests): Omit<CapturedRequest, 'id' | 'captureId'>[] {
  let doc: unknown = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > LIMITS.maxImportHarBytes) throw new BrowserForgeError('LIMIT_EXCEEDED', 'HAR file too large');
    try {
      doc = JSON.parse(input);
    } catch {
      throw new BrowserForgeError('INVALID_ARGUMENTS', 'HAR is not valid JSON');
    }
  }
  const parsed = HarSchema.safeParse(doc);
  if (!parsed.success) throw new BrowserForgeError('INVALID_ARGUMENTS', 'Not a valid HAR document (log.entries missing or malformed)');
  const entries = parsed.data.log.entries.slice(0, maxEntries);
  return entries.map((e) => {
    const started = Date.parse(e.startedDateTime);
    const res = e.response;
    const base64 = res?.content?.encoding === 'base64';
    return {
      url: e.request.url,
      method: e.request.method.toUpperCase(),
      requestHeaders: e.request.headers,
      requestBody: e.request.postData?.text,
      status: res && res.status > 0 ? res.status : undefined,
      statusText: res?.statusText || undefined,
      responseHeaders: res?.headers ?? [],
      responseBody: res?.content?.text,
      responseBodyBase64: base64 || undefined,
      mimeType: res?.content?.mimeType || undefined,
      resourceType: e._resourceType,
      tabId: e._tabId,
      startedAt: Number.isFinite(started) ? started : Date.now(),
      durationMs: e.time && e.time > 0 ? e.time : undefined,
    };
  });
}
