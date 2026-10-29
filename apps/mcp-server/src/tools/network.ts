import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { details, exportHar, LIVE_CAPTURE, parseHar, summarize, type RequestFilter } from '@browserforge/network-inspector';
import { BrowserForgeError, LIMITS, resolveSafePath } from '@browserforge/shared';
import type { ServerContext } from '../context.js';
import { registerTool, untrusted } from './helpers.js';

const captureId = z.string().max(100).optional().describe(`Capture to read (default "${LIVE_CAPTURE}")`);
const filterShape = {
  hostname: z.string().max(253).optional().describe('Exact host or wildcard like *.example.com'),
  urlPattern: z.string().max(500).optional().describe('Substring, or glob using *'),
  method: z.union([z.string().max(16), z.array(z.string().max(16)).max(10)]).optional(),
  status: z.union([z.number().int(), z.string().max(20), z.array(z.union([z.number().int(), z.string().max(20)])).max(20)]).optional().describe('200, "2xx", "400-499" or a list'),
  contentType: z.string().max(100).optional(),
  tabId: z.number().int().optional(),
  browserId: z.string().max(100).optional(),
  resourceType: z.string().max(40).optional(),
  hasResponseBody: z.boolean().optional(),
};
const paging = {
  cursor: z.string().max(20).optional().describe('nextCursor from a previous page'),
  limit: z.number().int().min(1).max(LIMITS.maxPageSize).optional(),
};
const revealArg = z.boolean().optional().describe('Return unredacted secrets. Refused unless the server was started with --allow-reveal.');

function checkReveal(ctx: ServerContext, reveal: boolean | undefined, what: string): boolean {
  if (!reveal) return false;
  if (!ctx.config.allowReveal) {
    throw new BrowserForgeError('PERMISSION_DENIED', 'Revealing redacted values is disabled. The user must start the server with --allow-reveal (or BROWSERFORGE_ALLOW_REVEAL=1) for authorized debugging.');
  }
  ctx.logger.warn('sensitive values revealed', { what });
  return true;
}

export function registerNetworkTools(server: McpServer, ctx: ServerContext): void {
  registerTool(server, ctx, {
    name: 'network_list_requests', title: 'List captured requests', readOnly: true,
    description: 'List captured HTTP requests (redacted summaries) with filters and pagination. Capture covers what the browser extension can observe; see docs/LIMITATIONS.md.',
    input: z.object({ captureId, ...filterShape, ...paging }),
    run: async ({ captureId, cursor, limit, ...filter }) => {
      const page = ctx.store.query(captureId, filter as RequestFilter, { cursor, limit });
      return untrusted('network', { total: page.total, nextCursor: page.nextCursor, requests: page.items.map((r) => summarize(r)) });
    },
  });
  registerTool(server, ctx, {
    name: 'network_get_request', title: 'Get request', readOnly: true,
    description: 'Get one captured request: summary, query parameters and headers (no bodies; use network_get_request_details for bodies).',
    input: z.object({ requestId: z.string().max(40), reveal: revealArg }),
    run: async ({ requestId, reveal }) => {
      const r = ctx.store.get(requestId);
      const d = details(r, { reveal: checkReveal(ctx, reveal, 'network_get_request'), includeBodies: false });
      return untrusted('network', d);
    },
  });
  registerTool(server, ctx, {
    name: 'network_get_request_details', title: 'Get request details', readOnly: true,
    description: 'Full captured request incl. (redacted, size-limited) request/response bodies when the browser could capture them.',
    input: z.object({ requestId: z.string().max(40), reveal: revealArg, maxBodyChars: z.number().int().min(100).max(200_000).optional() }),
    run: async ({ requestId, reveal, maxBodyChars }) => untrusted('network', details(ctx.store.get(requestId), { reveal: checkReveal(ctx, reveal, 'network_get_request_details'), maxBodyChars })),
  });
  registerTool(server, ctx, {
    name: 'network_search_requests', title: 'Search requests', readOnly: true,
    description: 'Full-text search over method, URL and (text) request/response bodies, combinable with filters.',
    input: z.object({ query: z.string().min(1).max(200), captureId, ...filterShape, ...paging }),
    run: async ({ query, captureId, cursor, limit, ...filter }) => {
      const page = ctx.store.query(captureId, filter as RequestFilter, { cursor, limit, text: query });
      return untrusted('network', { total: page.total, nextCursor: page.nextCursor, requests: page.items.map((r) => summarize(r)) });
    },
  });
  registerTool(server, ctx, {
    name: 'network_list_captures', title: 'List captures', readOnly: true,
    description: 'List capture sets (live traffic and imported HAR files) and capture limits.',
    input: z.object({}),
    run: async () => ({ captures: ctx.store.listCaptures(), limits: ctx.store.getLimits() }),
  });
  registerTool(server, ctx, {
    name: 'network_configure_capture', title: 'Configure capture', readOnly: false,
    description: 'Start/stop live capture in the browser, enable response-body capture (opt-in; may need extra browser permission), and set retention limits.',
    input: z.object({
      browserId: z.string().max(100).optional(),
      enabled: z.boolean().optional(),
      captureBodies: z.boolean().optional(),
      tabIds: z.array(z.number().int()).max(100).optional().describe('Restrict capture to these tabs (omit = all tabs)'),
      maxBodyBytes: z.number().int().positive().max(2_000_000).optional(),
      maxRequests: z.number().int().min(10).max(50_000).optional(),
      retentionMinutes: z.number().int().min(0).max(1440).optional(),
    }),
    run: async ({ browserId, maxRequests, retentionMinutes, ...cfg }, x) => {
      if (maxRequests !== undefined || retentionMinutes !== undefined) ctx.store.setLimits({ maxRequestsPerCapture: maxRequests, retentionMs: retentionMinutes === undefined ? undefined : retentionMinutes * 60_000 });
      const browser = await ctx.hub.call('network_configure', cfg, { browserId, signal: x.signal });
      return { browser, limits: ctx.store.getLimits() };
    },
  });
  registerTool(server, ctx, {
    name: 'network_export_har', title: 'Export HAR', readOnly: false,
    description: 'Export a capture (optionally filtered) as HAR 1.2. Redacted by default. With "path" the file is written inside an allowed export directory; otherwise a size-limited HAR is returned inline.',
    input: z.object({ captureId, ...filterShape, path: z.string().max(1000).optional().describe('Output file path inside an allowed export directory'), includeSensitive: revealArg, maxEntries: z.number().int().min(1).max(20_000).optional() }),
    run: async ({ captureId, path: outPath, includeSensitive, maxEntries, ...filter }) => {
      const sensitive = checkReveal(ctx, includeSensitive, 'network_export_har');
      const items = ctx.store.queryAll(captureId, filter as RequestFilter).slice(0, maxEntries ?? 20_000);
      const har = exportHar(items, { includeSensitive: sensitive });
      const text = JSON.stringify(har);
      if (outPath) {
        const real = resolveSafePath(outPath.includes(path.sep) || path.isAbsolute(outPath) ? outPath : path.join(ctx.config.writeRoots[0]!, outPath), ctx.config.writeRoots);
        fs.mkdirSync(path.dirname(real), { recursive: true, mode: 0o700 });
        fs.writeFileSync(real, text, { mode: 0o600 });
        return { written: real, entries: items.length, redacted: !sensitive, bytes: Buffer.byteLength(text) };
      }
      if (text.length > 400_000) throw new BrowserForgeError('LIMIT_EXCEEDED', 'HAR too large to return inline; pass "path" to write it to an export directory');
      return { entries: items.length, redacted: !sensitive, har };
    },
  });
  registerTool(server, ctx, {
    name: 'network_import_har', title: 'Import HAR', readOnly: false,
    description: 'Import a HAR file (from an allowed directory) or inline HAR JSON into a new capture for inspection and API analysis. Imported secrets are redacted on output like live traffic.',
    input: z.object({ path: z.string().max(1000).optional(), har: z.record(z.string(), z.unknown()).optional(), label: z.string().max(100).optional() }),
    run: async ({ path: inPath, har, label }) => {
      if (!inPath === !har) throw new BrowserForgeError('INVALID_ARGUMENTS', 'Provide exactly one of "path" or "har"');
      let source: string | object;
      if (inPath) {
        const real = resolveSafePath(inPath, [...ctx.config.writeRoots, ...ctx.config.uploadRoots]);
        const st = fs.statSync(real, { throwIfNoEntry: false });
        if (!st?.isFile()) throw new BrowserForgeError('NOT_FOUND', 'HAR file not found');
        if (st.size > LIMITS.maxImportHarBytes) throw new BrowserForgeError('LIMIT_EXCEEDED', 'HAR file too large');
        source = fs.readFileSync(real, 'utf8');
      } else source = har!;
      const entries = parseHar(source);
      const cap = ctx.store.createCapture(label ?? (inPath ? path.basename(inPath) : 'inline HAR'), 'har');
      for (const e of entries) ctx.store.add(cap.id, e);
      return { captureId: cap.id, imported: entries.length };
    },
  });
  registerTool(server, ctx, {
    name: 'network_clear_capture', title: 'Clear capture', readOnly: false, destructive: true,
    description: 'Delete captured traffic: one capture (live traffic is emptied; imported captures are removed) or everything when captureId is omitted.',
    input: z.object({ captureId: z.string().max(100).optional() }),
    run: async ({ captureId }) => ({ cleared: ctx.store.clear(captureId) }),
  });
}
