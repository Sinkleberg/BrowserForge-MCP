import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir, createLogger, loadOrCreateToken, type LogFile, type LogLevel, type Logger } from '@browserforge/shared';
import { NetworkStore } from '@browserforge/network-inspector';
import { BrowserHub } from './hub.js';
import type { AnalysisStore } from './analysis-store.js';
import type { WorkflowEngine } from './workflow.js';
import type { ProfileStore } from './profiles.js';
import type { DocStore, SiteStore, TraceStore } from '@browserforge/knowledge';
import type { FlowRecorder } from './flows/recorder.js';
import type { PluginStore } from './plugins/store.js';
import type { PluginRegistry } from './plugins/types.js';

export const SERVER_VERSION = '0.1.0';
export const DEFAULT_PORT = 7345;

export interface ServerConfig {
  host: '127.0.0.1';
  port: number;
  extensionToken: string;
  mcpToken: string;
  /** Allow tools to return unredacted secrets when the caller passes reveal:true. Off by default. */
  allowReveal: boolean;
  /** Directories the agent may read user files (CVs) from. */
  uploadRoots: string[];
  /** Directories the agent may write exports/generated clients into. */
  writeRoots: string[];
  configDir: string;
  logLevel: LogLevel;
  /** Local model that picks steps for browser_run_goal. Must be on this machine: page labels are sent to it. */
  decider: {
    /** qwen (default) = Qwen only; cascade = Laya first, Qwen when Laya is unsure; laya = Laya only. Measured 2026-10-29: Laya and Decider 0.8B got 1/5 signup steps right, Qwen3 4B all of them, and Qwen was as fast, so Qwen is the default. */
    mode: 'cascade' | 'qwen' | 'laya';
    url: string;
    model: string;
    minConfidence: number;
    timeoutMs: number;
    /** Ollaya decision model: tiny and fast, but a small context. */
    laya: { url: string; model: string; minConfidence: number };
  };
  /** Traces double as retrieval memory and fine-tuning data; they never contain input values. */
  knowledge: { traces: boolean; retentionDays: number };
  /** Record the sites agents work on as flows (see docs/FLOWS.md). */
  flows: { record: boolean };
  /** A private, rotating log file with everything the server logs (never page content, typed values or secrets). */
  logging: { file: boolean; retentionDays: number };
}

/** The decider receives page content, so only a loopback endpoint is accepted. */
export function assertLoopbackUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid decider URL '${raw}'`);
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || !/^https?:$/.test(u.protocol)) throw new Error('The decider must run on this machine (127.0.0.1, localhost or ::1): page content is sent to it');
  return u.origin;
}

export interface ToolEntry {
  input: import('zod').ZodObject;
  run: (args: never, extra: { signal: AbortSignal }) => Promise<unknown>;
}

export interface ServerContext {
  /** Registry of every tool handler, used by workflows to invoke tools in-process. */
  tools: Map<string, ToolEntry>;
  config: ServerConfig;
  hub: BrowserHub;
  store: NetworkStore;
  knowledge: { traces: TraceStore; docs: DocStore; sites: SiteStore };
  /** Saves every site the agent works on as a replayable, exportable flow. */
  flows: FlowRecorder;
  /** Installed plugins and skills (see docs/PLUGINS.md). */
  pluginStore: PluginStore;
  plugins: PluginRegistry;
  /** Extra flow export formats contributed by plugins. */
  extraExporters: import('@browserforge/flows').Exporter[];
  analyses: AnalysisStore<import('@browserforge/api-analyzer').AnalysisReport>;
  workflows: WorkflowEngine;
  profiles: ProfileStore;
  logger: Logger;
  /** Where the log is written, if file logging is on. */
  logFile?: LogFile;
  startedAt: number;
  /** Set by the transport layer so status can describe how clients are connected. */
  transports: { http: boolean; stdio: boolean; mcpSessions: () => number };
}

export function buildConfig(overrides: Partial<ServerConfig> & { extraAllowDirs?: string[] } = {}): ServerConfig {
  const dir = overrides.configDir ?? configDir();
  const home = os.homedir();
  const exportsDir = path.join(dir, 'exports');
  const filesDir = path.join(dir, 'files');
  fs.mkdirSync(exportsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  const extra = overrides.extraAllowDirs ?? [];
  const envDirs = (process.env.BROWSERFORGE_ALLOW_DIRS ?? '').split(path.delimiter).filter(Boolean);
  return {
    host: '127.0.0.1',
    port: overrides.port ?? Number(process.env.BROWSERFORGE_PORT ?? DEFAULT_PORT),
    extensionToken: overrides.extensionToken ?? loadOrCreateToken(path.join(dir, 'extension-token')),
    mcpToken: overrides.mcpToken ?? loadOrCreateToken(path.join(dir, 'mcp-token')),
    allowReveal: overrides.allowReveal ?? process.env.BROWSERFORGE_ALLOW_REVEAL === '1',
    uploadRoots: overrides.uploadRoots ?? [filesDir, path.join(home, 'Documents'), path.join(home, 'Downloads'), ...extra, ...envDirs],
    writeRoots: overrides.writeRoots ?? [exportsDir, ...extra, ...envDirs],
    configDir: dir,
    logLevel: overrides.logLevel ?? (process.env.BROWSERFORGE_LOG as LogLevel | undefined) ?? 'info',
    decider: {
      url: assertLoopbackUrl(overrides.decider?.url || process.env.BROWSERFORGE_DECIDER_URL || 'http://127.0.0.1:11434'),
      model: overrides.decider?.model || process.env.BROWSERFORGE_DECIDER_MODEL || 'qwen3:4b-instruct',
      minConfidence: overrides.decider?.minConfidence ?? 0.7,
      timeoutMs: overrides.decider?.timeoutMs ?? 90_000,
      mode: overrides.decider?.mode ?? ((process.env.BROWSERFORGE_DECIDER as 'cascade' | 'qwen' | 'laya' | undefined) || 'qwen'),
      laya: {
        url: assertLoopbackUrl(overrides.decider?.laya?.url || process.env.BROWSERFORGE_LAYA_URL || 'http://127.0.0.1:11435'),
        model: overrides.decider?.laya?.model || process.env.BROWSERFORGE_LAYA_MODEL || 'laya',
        minConfidence: overrides.decider?.laya?.minConfidence ?? 0.5,
      },
    },
    knowledge: { traces: overrides.knowledge?.traces ?? process.env.BROWSERFORGE_NO_TRACES !== '1', retentionDays: overrides.knowledge?.retentionDays ?? 90 },
    flows: { record: overrides.flows?.record ?? process.env.BROWSERFORGE_NO_FLOWS !== '1' },
    logging: { file: overrides.logging?.file ?? process.env.BROWSERFORGE_NO_LOG_FILE !== '1', retentionDays: overrides.logging?.retentionDays ?? 14 },
  };
}

export function createLoggerFor(config: ServerConfig, file?: LogFile): Logger {
  return createLogger(config.logLevel, undefined, file);
}
