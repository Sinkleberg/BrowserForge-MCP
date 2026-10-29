import { redactBody, redactHeaders, redactUrl, truncate, LIMITS } from '@browserforge/shared';
import { safeHost } from './filter.js';
import type { CapturedRequest, RequestDetails, RequestSummary, ViewOptions } from './types.js';

function parts(url: string): { host: string; path: string; query: Record<string, string[]> } {
  try {
    const u = new URL(url);
    const query: Record<string, string[]> = {};
    for (const [k, v] of u.searchParams) (query[k] ??= []).push(v);
    return { host: u.host, path: u.pathname, query };
  } catch {
    return { host: safeHost(url), path: url, query: {} };
  }
}

function header(r: CapturedRequest, name: string, which: 'req' | 'res'): string | undefined {
  const list = which === 'req' ? r.requestHeaders : r.responseHeaders;
  return list.find((h) => h.name.toLowerCase() === name)?.value;
}

export function summarize(r: CapturedRequest, opts: ViewOptions = {}): RequestSummary {
  const p = parts(r.url);
  return {
    id: r.id,
    captureId: r.captureId,
    method: r.method,
    url: opts.reveal ? r.url : redactUrl(r.url),
    host: p.host,
    path: p.path,
    status: r.status,
    mimeType: r.mimeType,
    resourceType: r.resourceType,
    tabId: r.tabId,
    startedAt: new Date(r.startedAt).toISOString(),
    durationMs: r.durationMs,
    requestBodyBytes: r.requestBody === undefined ? undefined : Buffer.byteLength(r.requestBody),
    responseBodyBytes: r.responseBody === undefined ? undefined : Buffer.byteLength(r.responseBody),
  };
}

export function details(r: CapturedRequest, opts: ViewOptions = {}): RequestDetails {
  const reveal = opts.reveal === true;
  const p = parts(r.url);
  const max = opts.maxBodyChars ?? LIMITS.maxTextChars;
  const query: Record<string, string[]> = {};
  if (reveal) Object.assign(query, p.query);
  else {
    const red = parts(redactUrl(r.url));
    Object.assign(query, red.query);
  }
  const reqCt = header(r, 'content-type', 'req');
  const resCt = r.mimeType ?? header(r, 'content-type', 'res');
  const reqBody = r.requestBody === undefined ? undefined : reveal ? r.requestBody : redactBody(r.requestBody, reqCt);
  const resBody =
    r.responseBody === undefined ? undefined : reveal || r.responseBodyBase64 ? r.responseBody : redactBody(r.responseBody, resCt);
  const out: RequestDetails = {
    ...summarize(r, opts),
    query,
    requestHeaders: reveal ? r.requestHeaders : redactHeaders(r.requestHeaders),
    responseHeaders: reveal ? r.responseHeaders : redactHeaders(r.responseHeaders),
    requestBodyTruncated: r.requestBodyTruncated,
    responseBodyTruncated: r.responseBodyTruncated,
    responseBodyBase64: r.responseBodyBase64,
    initiator: r.initiator,
    fromCache: r.fromCache,
    error: r.error,
    redacted: !reveal,
  };
  if (opts.includeBodies !== false) {
    if (reqBody !== undefined) {
      const t = truncate(reqBody, max);
      out.requestBody = t.text;
      if (t.truncated) out.requestBodyTruncated = true;
    }
    if (resBody !== undefined) {
      const t = truncate(resBody, max);
      out.responseBody = t.text;
      if (t.truncated) out.responseBodyTruncated = true;
    }
  }
  return out;
}
