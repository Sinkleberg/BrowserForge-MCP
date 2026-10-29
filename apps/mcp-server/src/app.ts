import { DocStore, TraceStore } from '@browserforge/knowledge';
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
import { BrowserHub, isLoopbackHost } from './hub.js';
import { createMcpServer } from './mcp.js';
import { ProfileStore } from './profiles.js';
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
  const logger: Logger = createLoggerFor(config);
  const hub = new BrowserHub({ extensionToken: config.extensionToken, serverVersion: SERVER_VERSION, logger, extraAllowedOrigins: overrides.extraAllowedOrigins });
  const store = new NetworkStore();
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

  const ctx: ServerContext = {
    config, hub, store, logger, startedAt: Date.now(),
    tools: new Map(),
    knowledge: {
      traces: new TraceStore(path.join(config.configDir, 'knowledge'), { enabled: config.knowledge.traces, retentionDays: config.knowledge.retentionDays }),
      docs: new DocStore(path.join(config.configDir, 'knowledge')),
    },
    analyses: new AnalysisStore<AnalysisReport>(),
    profiles: new ProfileStore(path.join(config.configDir, 'profiles.json')),
    workflows: undefined as never,
    transports: { http: false, stdio: false, mcpSessions: () => sessions.size },
  };
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
    listen: () =>
      new Promise((resolve, reject) => {
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
      }),
    serveStdio: async () => {
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
    },
  };
  return app;
}
