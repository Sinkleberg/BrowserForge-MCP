import { DocStore, SiteStore, TraceStore } from '@browserforge/knowledge';
import { HumanTraces, humanRunId } from './flows/human.js';
import { feedSites, feedSitesHuman } from './sites-feed.js';
import { pageFromElements, verifyOutcome } from './verify.js';
import { createLogFile } from '@browserforge/shared';
import { FlowRecorder } from './flows/recorder.js';
import { loadPlugins } from './plugins/loader.js';
import { PluginStore } from './plugins/store.js';
import { emptyRegistry } from './plugins/types.js';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnalysisReport } from '@browserforge/api-analyzer';
import { NetworkStore } from '@browserforge/network-inspector';
import { BrowserForgeError, safeEqual, type Logger } from '@browserforge/shared';
import { AnalysisStore } from './analysis-store.js';
import { SERVER_VERSION, buildConfig, createLoggerFor, type ServerConfig, type ServerContext } from './context.js';
import { createCaptchaSolver } from './tools/captcha.js';
import { BrowserHub, isLoopbackHost } from './hub.js';
import { createMcpServer } from './mcp.js';
import { ProfileStore } from './profiles.js';
import { AskQueue } from './asks.js';
import { systemStatus } from './tools/system.js';
import { validateWorkflowStep } from './tools/workflow.js';
import { WorkflowEngine } from './workflow.js';

export interface App {
  ctx: ServerContext;
  httpServer: http.Server;
  /** Actual port after listen (useful when port 0 was requested). */
  port: number;
  listen(): Promise<number>;
  serveStdio(): Promise<void>;
  close(): Promise<void>;
}

const MAX_BODY = 4 * 1024 * 1024;
const MAX_SESSIONS = 50;

export function createApp(overrides: Partial<ServerConfig> & { extraAllowDirs?: string[]; extraAllowedOrigins?: string[]; registerExtra?: (server: McpServer, ctx: ServerContext) => void } = {}): App {
  const config = buildConfig(overrides);
  const logFile = config.logging.file ? createLogFile(path.join(config.configDir, 'logs'), { retentionDays: config.logging.retentionDays }) : undefined;
  const logger: Logger = createLoggerFor(config, logFile);
  logger.info('server created', { version: SERVER_VERSION, node: process.version, platform: process.platform, decider: config.decider.mode, flows: config.flows.record, logFile: Boolean(logFile) });
  const hub = new BrowserHub({ extensionToken: config.extensionToken, serverVersion: SERVER_VERSION, logger, extraAllowedOrigins: overrides.extraAllowedOrigins });
  const store = new NetworkStore();
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

  const ctx: ServerContext = {
    config, hub, store, logger, logFile, startedAt: Date.now(),
    tools: new Map(),
    knowledge: {
      traces: new TraceStore(path.join(config.configDir, 'knowledge'), { enabled: config.knowledge.traces, retentionDays: config.knowledge.retentionDays }),
      docs: new DocStore(path.join(config.configDir, 'knowledge')),
      sites: new SiteStore(path.join(config.configDir, 'knowledge'), Date.now, config.knowledge.traces),
    },
    extraExporters: [],
    pluginStore: new PluginStore(config.configDir),
    plugins: emptyRegistry(),
    flows: new FlowRecorder(path.join(config.configDir, 'flows'), { enabled: config.flows.record, storeValues: config.flows.storeValues, ...(config.flows.ignore ? { ignore: config.flows.ignore } : {}) }, Date.now, (site, id) => ctx.knowledge.sites.addFlow(site, id)),
    analyses: new AnalysisStore<AnalysisReport>(),
    profiles: new ProfileStore(path.join(config.configDir, 'profiles.json')),
    asks: new AskQueue(),
    workflows: undefined as never,
    captchaSolver: createCaptchaSolver(config.captcha, logger),
    transports: { http: false, stdio: false, mcpSessions: () => sessions.size },
  };
  if (ctx.captchaSolver) {
    logger.info('capskip captcha solver enabled', { url: config.captcha.url });
  }
  ctx.workflows = new WorkflowEngine({
    logger,
    validateStep: (spec) => validateWorkflowStep(ctx, spec),
    invoke: async (tool, args, signal) => {
      const entry = ctx.tools.get(tool);
      if (!entry) throw new BrowserForgeError('INVALID_ARGUMENTS', `Unknown tool '${tool}'`);
      return entry.run(entry.input.parse(args) as never, { signal });
    },
    requestApproval: async (title, detail, signal) => {
      const r = (await hub.call('request_approval', { title, detail, timeoutMs: 300_000 }, { timeoutMs: 305_000, signal, browserId: ctx.hub.resolvePeer().id })) as { approved?: boolean };
      return r.approved === true;
    },
  });

  hub.on('actionDone', (browserId, action, args, result, flow) => {
    ctx.flows.handle(browserId, action, args, result, flow);
    feedSites(ctx.knowledge.sites, action, result, flow);
    // After a submit-like step, look at the page a moment later: a confirmation or an error says how the task went, with no model involved.
    if (flow?.some((p) => p.consequential === true) && (action === 'click' || action === 'press_key' || action === 'type')) {
      const first = flow.find((p) => typeof p.pageUrl === 'string' || typeof p.url === 'string');
      void verifyAfterSubmit({ browserId, tabId: typeof args.tabId === 'number' ? args.tabId : undefined, flowKey: browserId, pageUrl: String(first?.pageUrl ?? first?.url ?? '') });
    }
  });

  // The person pressed "Ask the agent" in the popup: queue it for whichever agent asks (tool) or is watching (GET /asks).
  hub.on('askAgent', (browserId, d) => { ctx.asks.add(browserId, d); });

  // The person's own actions (only while they have "Record me" on): their own flow, training examples, and what the site teaches.
  const humanTraces = new HumanTraces();
  hub.on('humanAction', (browserId, d) => {
    const r = ctx.flows.handleHuman(browserId, d);
    if (!r) return;
    feedSitesHuman(ctx.knowledge.sites, d, r.isNew);
    const step = humanTraces.step(d, r.flowId, r.param);
    if (step) ctx.knowledge.traces.record(step);
    if (d.consequential && (d.kind === 'click' || d.kind === 'press')) void verifyAfterSubmit({ browserId, tabId: d.tabId, flowKey: `human:${browserId}`, pageUrl: d.url, runId: humanRunId(r.flowId) });
  });

  /** A moment after a submit, look at the page: a confirmation or an error says how the task went, with no model involved. */
  async function verifyAfterSubmit(o: { browserId: string; tabId?: number; flowKey: string; pageUrl: string; runId?: string }): Promise<void> {
    try {
      await new Promise((r) => setTimeout(r, 1500));
      const page = pageFromElements(await hub.call('interactive_elements', { ...(o.tabId === undefined ? {} : { tabId: o.tabId }), format: 'table', limit: 120 }, { browserId: o.browserId, timeoutMs: 15_000 }));
      const v = verifyOutcome(page);
      if (v.verdict === 'unknown') return;
      const host = SiteStore.hostOf(o.pageUrl || page.url);
      if (host) ctx.knowledge.sites.outcome(host, v.verdict);
      ctx.flows.setOutcome(o.flowKey, v.verdict, o.tabId);
      if (o.runId) ctx.knowledge.traces.label(o.runId, v.verdict === 'success' ? 'good' : 'bad', `auto: ${v.signals.join('; ')}`.slice(0, 300), 'auto');
      logger.info('task outcome', { browser: o.browserId, host, verdict: v.verdict, signals: v.signals.join('; ') });
    } catch {
      /* the page may have navigated away or the browser disconnected: no verdict */
    }
  }

  hub.on('network', (browserId, d) => {
    store.upsertLive(browserId, d.requestId, {
      browserId, tabId: d.tabId, url: d.url, method: d.method,
      requestHeaders: d.requestHeaders, requestBody: d.requestBody, requestBodyTruncated: d.requestBodyTruncated,
      status: d.status, statusText: d.statusText, responseHeaders: d.responseHeaders,
      responseBody: d.responseBody, responseBodyBase64: d.responseBodyBase64, responseBodyTruncated: d.responseBodyTruncated,
      mimeType: d.mimeType, resourceType: d.resourceType, initiator: d.initiator, startedAt: d.startedAt,
      durationMs: d.endedAt ? d.endedAt - d.startedAt : undefined, fromCache: d.fromCache, error: d.error,
    });
  });

  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };

  const authorized = (req: http.IncomingMessage): boolean => {
    const h = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return !!m && safeEqual(m[1]!.trim(), config.mcpToken);
  };

  /** Web pages always send an Origin header on cross-site requests; CLI MCP clients never do. Refuse any request that has one. */
  const originAllowed = (req: http.IncomingMessage): boolean => !req.headers.origin;

  const readBody = (req: http.IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new BrowserForgeError('LIMIT_EXCEEDED', 'Request body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined);
        } catch {
          reject(new BrowserForgeError('INVALID_ARGUMENTS', 'Invalid JSON'));
        }
      });
      req.on('error', reject);
    });

  const handleMcp = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const sid = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;
    if (req.method === 'POST') {
      let body: unknown;
      try {
        body = await readBody(req);
      } catch (e) {
        return json(res, e instanceof BrowserForgeError && e.code === 'LIMIT_EXCEEDED' ? 413 : 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Bad request body' }, id: null });
      }
      if (sessionId && sessions.has(sessionId)) return sessions.get(sessionId)!.transport.handleRequest(req, res, body);
      if (!sessionId && isInitializeRequest(body)) {
        if (sessions.size >= MAX_SESSIONS) return json(res, 503, { jsonrpc: '2.0', error: { code: -32000, message: 'Too many sessions' }, id: null });
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, server });
          },
        });
        const server = createMcpServer(ctx, (s) => overrides.registerExtra?.(s, ctx));
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
        return transport.handleRequest(req, res, body);
      }
      return json(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Missing or unknown Mcp-Session-Id (send initialize first)' }, id: null });
    }
    if ((req.method === 'GET' || req.method === 'DELETE') && sessionId && sessions.has(sessionId)) return sessions.get(sessionId)!.transport.handleRequest(req, res);
    return json(res, 405, { error: 'Method not allowed' }, { allow: 'POST, GET, DELETE' });
  };

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      try {
        if (!isLoopbackHost(req.headers.host)) return json(res, 403, { error: 'Forbidden host' });
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { ok: true, name: 'browserforge-mcp', version: SERVER_VERSION });
        // Browser-originated requests (CSRF / DNS rebinding) are never legitimate for authenticated endpoints.
        if (!originAllowed(req) || req.method === 'OPTIONS') return json(res, 403, { error: 'Cross-origin requests are not allowed' });
        if (!authorized(req)) return json(res, 401, { error: 'Unauthorized' }, { 'www-authenticate': 'Bearer realm="browserforge"' });
        if (url.pathname === '/status' && req.method === 'GET') return json(res, 200, systemStatus(ctx));
        if (url.pathname === '/asks' && req.method === 'GET') {
          // Long-poll for "Ask the agent" presses newer than ?after=; used by `browserforge watch`.
          const ac = new AbortController();
          res.on('close', () => ac.abort());
          const waitMs = Math.min(Math.max(Number(url.searchParams.get('wait') ?? 0) || 0, 0), 30) * 1000;
          return json(res, 200, { asks: await ctx.asks.waitFor(Number(url.searchParams.get('after') ?? 0) || 0, waitMs, ac.signal) });
        }
        if (url.pathname === '/mcp') return await handleMcp(req, res);
        return json(res, 404, { error: 'Not found' });
      } catch (err) {
        logger.error('http handler failed', { error: err instanceof Error ? err : String(err) });
        if (!res.headersSent) json(res, 500, { error: 'Internal error' });
        else res.end();
      }
    })();
  });
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ext') {
      socket.destroy();
      return;
    }
    try {
      hub.handleUpgrade(req, socket, head);
    } catch (err) {
      logger.error('websocket upgrade failed', { error: err instanceof Error ? err : String(err) });
      socket.destroy();
    }
  });

  const app: App = {
    ctx, httpServer, port: config.port,
    listen: async () => {
      await loadPlugins(ctx); // plugins are imported before any client can connect
      return new Promise<number>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(config.port, config.host, () => {
          const addr = httpServer.address();
          const port = typeof addr === 'object' && addr ? addr.port : config.port;
          app.port = port;
          config.port = port;
          ctx.transports.http = true;
          logger.info('listening', { host: config.host, port });
          resolve(port);
        });
      });
    },
    serveStdio: async () => {
      await loadPlugins(ctx);
      ctx.transports.stdio = true;
      const server = createMcpServer(ctx, (s) => overrides.registerExtra?.(s, ctx));
      await server.connect(new StdioServerTransport());
    },
    close: async () => {
      ctx.workflows.cancelAll();
      for (const s of sessions.values()) await s.transport.close().catch(() => undefined);
      hub.close();
      httpServer.closeAllConnections();
      await new Promise<void>((r) => httpServer.close(() => r()));
      logger.info('server closed');
      logFile?.close();
    },
  };
  return app;
}
