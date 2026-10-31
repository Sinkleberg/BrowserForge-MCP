import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { ACTIONS, ExtensionMessageSchema, HelloSchema, PROTOCOL_VERSION, isActionName, type ActionName, type Capabilities, type HumanActionEvent, type AskAgentEvent, type Hello, type NetworkEvent } from '@browserforge/browser-protocol';
import { BrowserForgeError, LIMITS, clamp, safeEqual, type Logger } from '@browserforge/shared';

export interface HubOptions {
  extensionToken: string;
  serverVersion: string;
  logger: Logger;
  /** How long a dropped browser keeps its in-flight requests before they fail. */
  reconnectGraceMs?: number;
  helloTimeoutMs?: number;
  maxPayload?: number;
  /** Extra Origins accepted besides moz-extension:// and chrome-extension:// (tests only). */
  extraAllowedOrigins?: string[];
}

interface Pending {
  id: string;
  action: ActionName;
  args: unknown;
  timeoutMs: number;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: NodeJS.Timeout;
  sentAt: number;
  cleanup: () => void;
}

export interface ActivityEntry {
  at: number;
  action: string;
  summary: string;
  tabId?: number;
  outcome: 'ok' | 'error' | 'pending' | 'denied';
}

class Peer {
  ws: WebSocket | null = null;
  pending = new Map<string, Pending>();
  graceTimer?: NodeJS.Timeout;
  activity: ActivityEntry[] = [];
  connectedAt = Date.now();
  disconnectedAt?: number;
  lastSeen = Date.now();
  reconnects = 0;
  constructor(public hello: Hello, public sessionId: string) {}
  get id(): string {
    return this.hello.browser.id;
  }
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

export interface PeerInfo {
  browserId: string;
  kind: 'firefox' | 'chrome';
  version: string;
  connected: boolean;
  connectedAt: string;
  lastSeen: string;
  reconnects: number;
  inFlight: number;
  capabilities: Capabilities;
  extensionVersion: string;
}

export interface HubEvents {
  network: [browserId: string, data: NetworkEvent['data']];
  /** The person (not an agent) did something while "Record me" was on. */
  humanAction: [browserId: string, data: HumanActionEvent['data']];
  /** The person pressed "Ask the agent" in the popup. */
  askAgent: [browserId: string, data: AskAgentEvent['data']];
  connected: [browserId: string];
  disconnected: [browserId: string];
  /** A state-changing browser action succeeded. `flow` is what the page reported about the elements it touched (stripped from the result the agent sees). */
  actionDone: [browserId: string, action: string, args: Record<string, unknown>, result: unknown, flow: Record<string, unknown>[] | undefined];
}

const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export function isLoopbackHost(hostHeader: string | undefined): boolean {
  return !!hostHeader && LOOPBACK_HOST_RE.test(hostHeader);
}

export class BrowserHub extends EventEmitter<HubEvents> {
  private wss: WebSocketServer;
  private peers = new Map<string, Peer>();
  /** Browser the agent last addressed explicitly; used as the default when several are connected. */
  private lastUsedId: string | undefined;
  private unauthenticated = new Set<WebSocket>();
  readonly recentErrors: { at: string; code: string; action?: string }[] = [];
  private opts: Required<Omit<HubOptions, 'logger' | 'extraAllowedOrigins'>> & { logger: Logger; extraAllowedOrigins: string[] };

  constructor(opts: HubOptions) {
    super();
    this.opts = {
      reconnectGraceMs: opts.reconnectGraceMs ?? 5_000,
      helloTimeoutMs: opts.helloTimeoutMs ?? 5_000,
      maxPayload: opts.maxPayload ?? LIMITS.maxMessageBytes,
      extraAllowedOrigins: opts.extraAllowedOrigins ?? [],
      extensionToken: opts.extensionToken,
      serverVersion: opts.serverVersion,
      logger: opts.logger,
    };
    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.opts.maxPayload });
  }

  // ---------- connection handling ----------

  /** Validate and upgrade a WebSocket handshake. Rejects non-loopback Host and non-extension Origin. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const reject = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (!isLoopbackHost(req.headers.host)) return reject('403 Forbidden');
    const origin = req.headers.origin;
    const originOk =
      !!origin && (origin.startsWith('moz-extension://') || origin.startsWith('chrome-extension://') || this.opts.extraAllowedOrigins.includes(origin));
    if (!originOk) {
      this.recordError('BAD_ORIGIN');
      return reject('403 Forbidden');
    }
    if (this.unauthenticated.size >= 10) return reject('429 Too Many Requests');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  }

  private onConnection(ws: WebSocket): void {
    this.unauthenticated.add(ws);
    const helloTimer = setTimeout(() => {
      if (this.unauthenticated.has(ws)) ws.close(4408, 'hello timeout');
    }, this.opts.helloTimeoutMs);
    let peer: Peer | undefined;
    let strikes = 0;

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return ws.close(4400, 'binary not supported');
      let json: unknown;
      try {
        json = JSON.parse(raw.toString('utf8'));
      } catch {
        return ws.close(4400, 'invalid json');
      }
      if (!peer) {
        const parsed = HelloSchema.safeParse(json);
        if (!parsed.success) return ws.close(4400, 'expected hello');
        if (!safeEqual(parsed.data.token, this.opts.extensionToken)) {
          this.recordError('UNAUTHORIZED');
          this.opts.logger.warn('extension auth failed');
          return ws.close(4401, 'unauthorized');
        }
        clearTimeout(helloTimer);
        this.unauthenticated.delete(ws);
        peer = this.attach(ws, parsed.data);
        return;
      }
      peer.lastSeen = Date.now();
      const msg = ExtensionMessageSchema.safeParse(json);
      if (!msg.success) {
        this.opts.logger.warn('invalid message from extension', { browserId: peer.id });
        if (++strikes > 5) ws.close(4400, 'too many invalid messages');
        return;
      }
      this.onMessage(peer, msg.data);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      this.unauthenticated.delete(ws);
      if (peer && peer.ws === ws) this.onPeerDisconnect(peer);
    });
    ws.on('error', () => ws.terminate());
  }

  private attach(ws: WebSocket, hello: Hello): Peer {
    let peer = this.peers.get(hello.browser.id);
    if (peer) {
      // Reconnect: replace the old socket and resume in-flight requests.
      clearTimeout(peer.graceTimer);
      const old = peer.ws;
      peer.ws = ws;
      peer.hello = hello;
      peer.disconnectedAt = undefined;
      peer.reconnects++;
      if (old && old !== ws) old.close(4000, 'replaced');
    } else {
      peer = new Peer(hello, randomUUID());
      peer.ws = ws;
      this.peers.set(peer.id, peer);
    }
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello_ack', serverVersion: this.opts.serverVersion, sessionId: peer.sessionId }));
    // Re-send unanswered requests; the extension de-duplicates by request id.
    for (const p of peer.pending.values()) this.send(peer, { v: PROTOCOL_VERSION, type: 'request', id: p.id, action: p.action, args: p.args, timeoutMs: p.timeoutMs });
    this.opts.logger.info('browser connected', { browserId: peer.id, kind: hello.browser.kind, reconnects: peer.reconnects });
    this.emit('connected', peer.id);
    return peer;
  }

  private onPeerDisconnect(peer: Peer): void {
    peer.ws = null;
    peer.disconnectedAt = Date.now();
    this.opts.logger.info('browser disconnected', { browserId: peer.id });
    this.emit('disconnected', peer.id);
    peer.graceTimer = setTimeout(() => {
      for (const p of [...peer.pending.values()]) this.settle(peer, p, 'reject', new BrowserForgeError('NOT_CONNECTED', 'Browser disconnected while the request was in flight', { retryable: true }));
      if (!peer.connected) this.peers.delete(peer.id);
    }, this.opts.reconnectGraceMs);
  }

  private onMessage(peer: Peer, msg: ReturnType<typeof ExtensionMessageSchema.parse>): void {
    switch (msg.type) {
      case 'response': {
        const p = peer.pending.get(msg.id);
        if (!p) return; // duplicate or late response
        if (msg.ok) this.settle(peer, p, 'resolve', msg.result);
        else {
          this.recordError(msg.error.code, p.action);
          this.settle(peer, p, 'reject', new BrowserForgeError(msg.error.code, msg.error.message, { retryable: msg.error.retryable, details: msg.error.details }));
        }
        return;
      }
      case 'event':
        if (msg.event === 'network') this.emit('network', peer.id, msg.data);
        else if (msg.event === 'ask') {
          this.opts.logger.info('person asked the agent', { browser: peer.id, tab: msg.data.tabId });
          this.emit('askAgent', peer.id, msg.data);
        } else if (msg.event === 'human') {
          this.opts.logger.debug('human action', { browser: peer.id, tab: msg.data.tabId, kind: msg.data.kind });
          this.emit('humanAction', peer.id, msg.data);
        } else {
          peer.activity.push(msg.data);
          // The browser's own timeline (clicks, approvals, YOLO, STOP) joins the server's log. Summaries carry the host and a ref, never typed values.
          this.opts.logger.info('browser activity', { browser: peer.id, tab: msg.data.tabId, action: msg.data.action, summary: msg.data.summary, outcome: msg.data.outcome });
          if (peer.activity.length > LIMITS.maxActivityLog) peer.activity.shift();
        }
        return;
      case 'ping':
        this.send(peer, { v: PROTOCOL_VERSION, type: 'pong' });
        return;
      default:
        return;
    }
  }

  private send(peer: Peer, message: unknown): boolean {
    if (!peer.ws || peer.ws.readyState !== WebSocket.OPEN) return false;
    peer.ws.send(JSON.stringify(message));
    return true;
  }

  private settle(peer: Peer, p: Pending, how: 'resolve' | 'reject', value: unknown): void {
    clearTimeout(p.timer);
    p.cleanup();
    peer.pending.delete(p.id);
    if (how === 'resolve') p.resolve(value);
    else p.reject(value);
  }

  private recordError(code: string, action?: string): void {
    this.opts.logger.warn('browser error', { code, action });
    this.recentErrors.push({ at: new Date().toISOString(), code, action });
    if (this.recentErrors.length > 50) this.recentErrors.shift();
  }

  // ---------- public API ----------

  listPeers(): PeerInfo[] {
    return [...this.peers.values()].map((p) => ({
      browserId: p.id,
      kind: p.hello.browser.kind,
      version: p.hello.browser.version,
      connected: p.connected,
      connectedAt: new Date(p.connectedAt).toISOString(),
      lastSeen: new Date(p.lastSeen).toISOString(),
      reconnects: p.reconnects,
      inFlight: p.pending.size,
      capabilities: p.hello.capabilities,
      extensionVersion: p.hello.extension.version,
    }));
  }

  getActivity(browserId?: string): ActivityEntry[] {
    return this.resolvePeer(browserId).activity.slice(-100);
  }

  resolvePeer(browserId?: string): Peer {
    if (browserId) {
      const p = this.peers.get(browserId);
      if (!p || !p.connected) throw new BrowserForgeError('NOT_CONNECTED', `Browser '${browserId}' is not connected`, { retryable: true });
      this.lastUsedId = p.id;
      return p;
    }
    const live = [...this.peers.values()].filter((p) => p.connected);
    if (live.length === 0)
      throw new BrowserForgeError('NOT_CONNECTED', 'No browser is connected. Open Firefox/Chrome with the BrowserForge extension and connect it (see system_status).', { retryable: true });
    if (live.length > 1) {
      // Only a browser the agent already chose in this run is assumed; the first call must still be explicit so nothing lands in the wrong browser.
      const last = live.find((p) => p.id === this.lastUsedId);
      if (last) return last;
    }
    if (live.length > 1)
      throw new BrowserForgeError('INVALID_ARGUMENTS', 'Multiple browsers are connected; pass browserId', { details: { browsers: live.map((p) => ({ browserId: p.id, kind: p.hello.browser.kind })) } });
    return live[0]!;
  }

  /** Send an action to a browser and await its result. */
  async call(action: string, args: unknown, opts: { browserId?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    const t0 = Date.now();
    const browser = (() => {
      try {
        return this.resolvePeer(opts.browserId).id;
      } catch {
        return undefined;
      }
    })();
    const tab = typeof (args as { tabId?: unknown } | undefined)?.tabId === 'number' ? (args as { tabId: number }).tabId : undefined;
    let result: unknown;
    try {
      result = await this.callRaw(action, args, opts);
    } catch (e) {
      this.opts.logger.warn('action failed', { action, browser, tab, ms: Date.now() - t0, code: e instanceof BrowserForgeError ? e.code : 'INTERNAL', error: e instanceof BrowserForgeError ? e.message : 'unexpected error' });
      throw e;
    }
    this.opts.logger.debug('action ok', { action, browser, tab, ms: Date.now() - t0 });
    // The page may describe the elements it touched (for flow recording). Agents never see that; listeners do.
    let flow: Record<string, unknown>[] | undefined;
    if (result && typeof result === 'object' && '_flow' in result) {
      flow = (result as { _flow?: Record<string, unknown>[] })._flow;
      delete (result as { _flow?: unknown })._flow;
    }
    if (isActionName(action) && !ACTIONS[action].readOnly) {
      try {
        this.emit('actionDone', this.resolvePeer(opts.browserId).id, action, (args ?? {}) as Record<string, unknown>, result, flow);
      } catch (e) {
        this.opts.logger.warn('actionDone listener failed', { error: e instanceof Error ? e.message : String(e) });
      }
    }
    return result;
  }

  private async callRaw(action: string, args: unknown, opts: { browserId?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    if (!isActionName(action)) throw new BrowserForgeError('INVALID_ARGUMENTS', `Unknown action '${action}'`);
    const parsed = ACTIONS[action].args.safeParse(args ?? {});
    if (!parsed.success) {
      throw new BrowserForgeError('INVALID_ARGUMENTS', `Invalid arguments for ${action}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
    }
    const peer = this.resolvePeer(opts.browserId);
    const timeoutMs = clamp(opts.timeoutMs ?? LIMITS.defaultToolTimeoutMs, 100, LIMITS.maxToolTimeoutMs);
    if (opts.signal?.aborted) throw new BrowserForgeError('CANCELLED', 'Request was cancelled');

    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        const p = peer.pending.get(id);
        if (!p) return;
        this.send(peer, { v: PROTOCOL_VERSION, type: 'cancel', id });
        this.settle(peer, p, 'reject', new BrowserForgeError('CANCELLED', 'Request was cancelled'));
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const pending: Pending = {
        id,
        action,
        args: parsed.data,
        timeoutMs,
        resolve,
        reject,
        sentAt: Date.now(),
        cleanup: () => opts.signal?.removeEventListener('abort', onAbort),
        timer: setTimeout(() => {
          const p = peer.pending.get(id);
          if (!p) return;
          this.send(peer, { v: PROTOCOL_VERSION, type: 'cancel', id });
          this.recordError('TIMEOUT', action);
          this.settle(peer, p, 'reject', new BrowserForgeError('TIMEOUT', `Browser did not answer '${action}' within ${timeoutMs}ms`, { retryable: true }));
        }, timeoutMs + 1_000),
      };
      peer.pending.set(id, pending);
      this.send(peer, { v: PROTOCOL_VERSION, type: 'request', id, action, args: parsed.data, timeoutMs });
    });
  }

  /** Cancel everything in flight and tell the browser to halt. */
  async emergencyStop(browserId?: string): Promise<{ cancelled: number }> {
    const peer = this.resolvePeer(browserId);
    let cancelled = 0;
    for (const p of [...peer.pending.values()]) {
      this.send(peer, { v: PROTOCOL_VERSION, type: 'cancel', id: p.id });
      this.settle(peer, p, 'reject', new BrowserForgeError('STOPPED', 'Stopped by browser_stop'));
      cancelled++;
    }
    await this.call('stop', {}, { browserId: peer.id, timeoutMs: 5_000 }).catch(() => undefined);
    return { cancelled };
  }

  close(): void {
    for (const peer of this.peers.values()) {
      clearTimeout(peer.graceTimer);
      for (const p of [...peer.pending.values()]) this.settle(peer, p, 'reject', new BrowserForgeError('NOT_CONNECTED', 'Server shutting down', { retryable: true }));
      peer.ws?.close(1001, 'server shutdown');
    }
    this.peers.clear();
    this.wss.close();
  }
}
