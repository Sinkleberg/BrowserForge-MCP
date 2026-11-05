/** Human-event wire limits are8 hosts/600 code units. At either limit old records may already be truncated. */
export function recordedShadow(shadow: unknown, css: unknown): string[] | undefined {
  if (shadow === undefined || (Array.isArray(shadow) && shadow.length === 0)) return undefined;
  if (!Array.isArray(shadow) || shadow.length >= 8 || typeof css !== 'string' || !css.trim() || css.length >= 600 ||
      !shadow.every((host) => typeof host === 'string' && host.trim() && host.length < 600)) {
    // An empty host is never a CSS selector. It fits the existing wire schema and survives recording,
    // so replay/export must refuse this step rather than omit it or target a clipped ancestor.
    return [''];
  }
  return [...shadow];
}
