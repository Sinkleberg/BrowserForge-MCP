/**
 * Thin cross-browser shim. Firefox exposes promise-based `browser.*`; Chrome (MV3) exposes promise-based `chrome.*`.
 * We feature-detect rather than sniff the user agent.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;
export const api: typeof chrome = (g.browser ?? g.chrome) as typeof chrome;
export const isFirefox: boolean = typeof g.browser !== 'undefined' && typeof g.browser.runtime?.getBrowserInfo === 'function';
export const browserKind: 'firefox' | 'chrome' = isFirefox ? 'firefox' : 'chrome';

export function browserVersion(): string {
  const m = /(?:Firefox|Chrome)\/([\d.]+)/.exec(g.navigator?.userAgent ?? '');
  return m?.[1] ?? 'unknown';
}
