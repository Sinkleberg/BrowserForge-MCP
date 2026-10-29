import type { CapturedRequest, RequestFilter } from './types.js';

function globToRegExp(glob: string): RegExp {
  const escaped = glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) return h === p.slice(2) || h.endsWith(p.slice(1));
  return h === p;
}

export function statusMatches(status: number | undefined, spec: number | string): boolean {
  if (status === undefined) return false;
  if (typeof spec === 'number') return status === spec;
  const s = spec.trim().toLowerCase();
  const cls = /^([1-5])xx$/.exec(s);
  if (cls) return Math.floor(status / 100) === Number(cls[1]);
  const range = /^(\d{3})-(\d{3})$/.exec(s);
  if (range) return status >= Number(range[1]) && status <= Number(range[2]);
  return /^\d{3}$/.test(s) && status === Number(s);
}

export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function matchesFilter(r: CapturedRequest, f: RequestFilter): boolean {
  if (f.hostname) {
    let hostname: string;
    try {
      hostname = new URL(r.url).hostname;
    } catch {
      return false;
    }
    if (!hostMatches(hostname, f.hostname)) return false;
  }
  if (f.urlPattern) {
    const p = f.urlPattern;
    if (p.includes('*')) {
      if (!globToRegExp(p).test(r.url)) return false;
    } else if (!r.url.toLowerCase().includes(p.toLowerCase())) return false;
  }
  if (f.method) {
    const methods = (Array.isArray(f.method) ? f.method : [f.method]).map((m) => m.toUpperCase());
    if (!methods.includes(r.method.toUpperCase())) return false;
  }
  if (f.status !== undefined) {
    const specs = Array.isArray(f.status) ? f.status : [f.status];
    if (!specs.some((s) => statusMatches(r.status, s))) return false;
  }
  if (f.contentType) {
    const ct = (r.mimeType ?? r.responseHeaders.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '').toLowerCase();
    if (!ct.includes(f.contentType.toLowerCase())) return false;
  }
  if (f.tabId !== undefined && r.tabId !== f.tabId) return false;
  if (f.browserId && r.browserId !== f.browserId) return false;
  if (f.resourceType && r.resourceType !== f.resourceType) return false;
  if (f.since !== undefined && r.startedAt < f.since) return false;
  if (f.until !== undefined && r.startedAt > f.until) return false;
  if (f.hasResponseBody !== undefined && Boolean(r.responseBody) !== f.hasResponseBody) return false;
  return true;
}
