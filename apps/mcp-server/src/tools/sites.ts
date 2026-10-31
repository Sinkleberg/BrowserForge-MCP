import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PITFALL_KINDS, SiteStore } from '@browserforge/knowledge';
import { BrowserForgeError } from '@browserforge/shared';
import type { ServerContext } from '../context.js';
import { registerTool, untrusted } from './helpers.js';

export function registerSiteTools(server: McpServer, ctx: ServerContext): void {
  const { sites } = ctx.knowledge;
  const hostOf = (s: string): string => {
    const h = SiteStore.hostOf(s);
    if (!h) throw new BrowserForgeError('INVALID_ARGUMENTS', 'Give a host name (example.com) or a full address');
    return h;
  };
  registerTool(server, ctx, {
    name: 'site_info', title: 'What is known about a site', readOnly: true,
    description: 'Everything BrowserForge has learned about a site from earlier work: how many times it was used, results, known obstacles (needs an account, CAPTCHA, a file box inside a popup, custom dropdowns), and recorded flows you can replay. browser_navigate already returns a short siteCard for the pages you open; use this for the full list.',
    input: z.object({ site: z.string().min(1).max(300).describe('Host name or address') }),
    run: async ({ site }) => {
      const host = hostOf(site);
      const k = sites.get(host);
      return untrusted('site_knowledge', k ? { ...k, card: sites.card(host) } : { host, known: false });
    },
  });
  registerTool(server, ctx, {
    name: 'site_note', title: 'Remember something about a site', readOnly: false,
    description: `Record an obstacle or tip about a site so the next agent knows before trying. kind is one of: ${PITFALL_KINDS.join(', ')}. detail is a short plain sentence (max 200 characters); never put personal data, passwords or page content in it.`,
    input: z.object({ site: z.string().min(1).max(300), kind: z.enum(PITFALL_KINDS), detail: z.string().max(200).optional() }),
    run: async ({ site, kind, detail }) => {
      const host = hostOf(site);
      sites.note(host, kind, detail ?? '');
      return { saved: true, card: sites.card(host) };
    },
  });
  registerTool(server, ctx, {
    name: 'site_list', title: 'Sites with saved knowledge', readOnly: true,
    description: 'Sites BrowserForge has knowledge about, most recent first.',
    input: z.object({}),
    run: async () => ({ sites: sites.list() }),
  });
}
