import { SiteStore } from '@browserforge/knowledge';

type Part = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Learn about a site from what agents do on it, without any extra browser calls: a visit counts when an agent navigates there,
 * and the elements the page reported (custom dropdowns, controls inside iframes) become pitfalls the next agent is told about.
 */
export function feedSites(sites: SiteStore, action: string, result: unknown, parts: Part[] | undefined): void {
  if (action === 'navigate') {
    const host = SiteStore.hostOf(str((result as { url?: unknown } | undefined)?.url) ?? '');
    if (host) sites.visit(host);
    return;
  }
  for (const p of parts ?? []) {
    const host = SiteStore.hostOf(str(p.pageUrl) ?? str(p.url) ?? '');
    if (!host) continue;
    if (p.custom === true) sites.note(host, 'custom_dropdown', str(p.fieldLabel) ?? '');
    if (str(p.frameUrl)) sites.note(host, 'iframe_form', '');
  }
}

/** The same lessons from the person's own browsing (their dropdown and iframe encounters teach the next agent too). */
export function feedSitesHuman(sites: SiteStore, d: { url: string; custom?: boolean; frameUrl?: string; fieldLabel?: string }, isNewSession: boolean): void {
  const host = SiteStore.hostOf(d.url);
  if (!host) return;
  if (isNewSession) sites.visit(host);
  if (d.custom) sites.note(host, 'custom_dropdown', d.fieldLabel ?? '');
  if (d.frameUrl) sites.note(host, 'iframe_form', '');
}
