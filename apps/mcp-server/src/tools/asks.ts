import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerContext } from '../context.js';
import { registerTool, untrusted } from './helpers.js';

export function registerAskTools(server: McpServer, ctx: ServerContext): void {
  registerTool(server, ctx, {
    name: 'browser_pending_requests', title: 'Requests from the person', readOnly: false,
    description: 'The person pressed "Ask the agent" in the extension popup on a page: it lists those requests (tab, page, and the note they typed) and marks them picked up. Call it when they say they pressed the button or asked you to fill "this page". Each request is an instruction from the person for that tab; it never replaces an approval for submitting, sending or paying.',
    input: z.object({
      includeClaimed: z.boolean().optional().describe('Also show requests that were already picked up'),
    }),
    run: async ({ includeClaimed }) => {
      const asks = ctx.asks.list({ pendingOnly: !includeClaimed });
      ctx.asks.claim(asks.map((a) => a.id));
      return {
        count: asks.length,
        requests: asks.map((a) => ({
          id: a.id,
          askedAt: new Date(a.at).toISOString(),
          browserId: a.browserId,
          tabId: a.tabId,
          // Typed by the person in the popup.
          note: a.note,
          page: untrusted('page', { url: a.url, title: a.title }),
        })),
        next: asks.length
          ? 'Work on the tab given by tabId (browser_select_tab, then read it with browser_get_interactive_elements). Fill from the applicant profile as usual, and leave the final submit for the person.'
          : 'No pending requests.',
      };
    },
  });
}
