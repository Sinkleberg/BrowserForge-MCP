#!/usr/bin/env node

import path from 'node:path';
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { BUILTIN_EXPORTERS, consolidate, getExporter } from '@browserforge/flows';
import { createApp } from './app.js';
import readline from 'node:readline/promises';
import { FlowRecorder } from './flows/recorder.js';
import { writeFlowSkill } from './flows/skill.js';
import * as commands from './plugins/commands.js';
import { PluginStore } from './plugins/store.js';
import { discoverSkills } from './plugins/skills.js';
import { SERVER_VERSION, buildConfig } from './context.js';
import { readLogs } from '@browserforge/shared';
import { EXTENSION_KINDS, findExtensionDir, setupReport, type ExtensionKind } from './setup.js';

const USAGE = `browserforge ${SERVER_VERSION} — local MCP server for the BrowserForge browser extension

Usage:
  browserforge serve  [--port N] [--allow-reveal] [--allow-dir DIR]...   Run the daemon (MCP over HTTP + extension WebSocket)
  browserforge stdio  [--port N] [--allow-reveal] [--allow-dir DIR]...   MCP over stdio; also listens for the extension
  browserforge setup  [--port N]                                         Step-by-step setup for your system: server, extension, AI client
  browserforge extension <chrome|chrome-bodies|firefox>                  Print the folder of the built extension to load in the browser
  browserforge tokens                                                    Print token file locations (and the extension token)
  browserforge plugin add <npm-name|git-url|./folder> [--yes] | list | remove|enable|disable|update <id> | config <id> [key=value...] | new <id> | validate <folder> | search <words>
  browserforge skill  add <folder> | list | new <name> | export <name> --to <dir>      Plugins and skills (see docs/PLUGINS.md)
  browserforge flow   list | export <id> --format <fmt> [--out FILE] [--defaults] | consolidate <site> --name N | to-skill <id> --name N   Recorded flows (see docs/FLOWS.md)
  browserforge logs   [--tail N] [--level debug|info|warn|error] [--since 30m|2h|1d]   Read the saved log (see docs/TROUBLESHOOTING.md)
  browserforge diagnostics [--since 1d]                                   A report to paste into a bug: versions, settings, recent warnings and errors
  browserforge doctor [--port N]                                         Check a running daemon
  browserforge print-config <codex|claude> [--port N]                    Print client configuration snippets

Local decider (browser_run_goal): [--decider qwen|cascade|laya] [--decider-url http://127.0.0.1:11434] [--decider-model qwen3:4b-instruct]
                                   [--laya-url http://127.0.0.1:11435] [--laya-model laya] [--no-traces] [--no-flows] [--no-log-file] [--log-retention-days N] [--trace-retention-days N]

Environment: BROWSERFORGE_DECIDER=cascade|qwen|laya, BROWSERFORGE_LAYA_URL, BROWSERFORGE_LAYA_MODEL, BROWSERFORGE_DECIDER_URL, BROWSERFORGE_DECIDER_MODEL, BROWSERFORGE_NO_TRACES=1, BROWSERFORGE_PORT, BROWSERFORGE_HOME, BROWSERFORGE_ALLOW_REVEAL=1, BROWSERFORGE_ALLOW_DIRS, BROWSERFORGE_LOG=debug|info|warn|error`;

/** "30m", "2h", "1d" -> that many milliseconds. */
function parseSince(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = /^(\d+)([mhd])$/.exec(v);
  if (!m) throw new Error('Invalid --since (use e.g. 30m, 2h, 1d)');
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
}

function parseMode(v: string | undefined): 'cascade' | 'qwen' | 'laya' {
  if (v === undefined) return (process.env.BROWSERFORGE_DECIDER as 'cascade' | 'qwen' | 'laya' | undefined) || 'qwen';
  if (v === 'cascade' || v === 'qwen' || v === 'laya') return v;
  throw new Error('Invalid --decider (use cascade, qwen or laya)');
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      'allow-reveal': { type: 'boolean' },
      'allow-dir': { type: 'string', multiple: true },
      'decider-url': { type: 'string' },
      'decider-model': { type: 'string' },
      decider: { type: 'string' },
      'laya-url': { type: 'string' },
      'laya-model': { type: 'string' },
      'no-traces': { type: 'boolean' },
      'no-flows': { type: 'boolean' },
      'no-log-file': { type: 'boolean' },
      'log-retention-days': { type: 'string' },
      tail: { type: 'string' },
      level: { type: 'string' },
      since: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      to: { type: 'string' },
      dir: { type: 'string' },
      format: { type: 'string' },
      out: { type: 'string' },
      defaults: { type: 'boolean' },
      name: { type: 'string' },
      description: { type: 'string' },
      'trace-retention-days': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, arg] = positionals;
  if (values.help || !cmd) {
    process.stdout.write(USAGE + '\n');
    return;
  }
  const port = values.port ? Number(values.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error('Invalid --port');
  const retention = values['trace-retention-days'] ? Number(values['trace-retention-days']) : undefined;
  if (retention !== undefined && (!Number.isInteger(retention) || retention < 1 || retention > 3650)) throw new Error('Invalid --trace-retention-days');
  const common = {
    port,
    allowReveal: values['allow-reveal'] ? true : undefined,
    extraAllowDirs: (values['allow-dir'] ?? []).map((d) => path.resolve(d)),
    ...(values['decider-url'] || values['decider-model'] || values.decider || values['laya-url'] || values['laya-model']
      ? { decider: { mode: parseMode(values.decider), url: values['decider-url'] ?? '', model: values['decider-model'] ?? '', minConfidence: 0.7, timeoutMs: 90_000, laya: { url: values['laya-url'] ?? '', model: values['laya-model'] ?? '', minConfidence: 0.5 } } }
      : {}),
    ...(values['no-flows'] ? { flows: { record: false } } : {}),
    ...(values['no-log-file'] || values['log-retention-days'] ? { logging: { file: !values['no-log-file'], retentionDays: Number(values['log-retention-days'] ?? 14) } } : {}),
    ...(values['no-traces'] || retention ? { knowledge: { traces: !values['no-traces'], retentionDays: retention ?? 90 } } : {}),
  };

  switch (cmd) {
    case 'serve': {
      const app = createApp(common);
      const p = await app.listen();
      process.stderr.write(
        `BrowserForge MCP listening on http://127.0.0.1:${p}\n  MCP endpoint : http://127.0.0.1:${p}/mcp  (Authorization: Bearer <mcp-token>)\n  Extension WS : ws://127.0.0.1:${p}/ext\n  Tokens       : ${app.ctx.config.configDir}/{extension-token,mcp-token}\n`,
      );
      const stop = () => void app.close().finally(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    case 'stdio': {
      const app = createApp(common);
      try {
        await app.listen();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          process.stderr.write(`Port ${app.ctx.config.port} is in use (is "browserforge serve" already running?). Use the HTTP transport, or pass --port.\n`);
          process.exit(1);
        }
        throw e;
      }
      await app.serveStdio();
      const stop = () => void app.close().finally(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      process.stdin.on('close', stop);
      return;
    }
    case 'setup': {
      const cfg = buildConfig({ port });
      const dirs: Partial<Record<ExtensionKind, string>> = {};
      for (const k of EXTENSION_KINDS) dirs[k] = findExtensionDir(k);
      process.stdout.write(setupReport({ version: SERVER_VERSION, nodeVersion: process.version, platform: process.platform, configDir: cfg.configDir, port: cfg.port, extensionToken: cfg.extensionToken, mcpTokenFile: path.join(cfg.configDir, 'mcp-token'), dirs }));
      return;
    }
    case 'extension': {
      const kind = arg as ExtensionKind;
      if (!EXTENSION_KINDS.includes(kind)) throw new Error(`Usage: browserforge extension <${EXTENSION_KINDS.join('|')}>`);
      const dir = findExtensionDir(kind);
      if (!dir) throw new Error(`The ${kind} extension is not built. In a checkout run: npm run build`);
      process.stdout.write(dir + '\n');
      return;
    }
    case 'tokens': {
      const cfg = buildConfig({ port });
      process.stdout.write(`Config dir      : ${cfg.configDir}\nExtension token : ${cfg.extensionToken}\n  (paste into the BrowserForge extension popup)\nMCP token file  : ${path.join(cfg.configDir, 'mcp-token')}\n  (used as Bearer token by Codex / Claude Code; never paste it into a web page)\n`);
      return;
    }
    case 'plugin':
    case 'skill': {
      const cfg = buildConfig(common);
      const store = new PluginStore(cfg.configDir);
      const [, sub, target, ...rest] = positionals;
      const io: commands.Io = {
        out: (t) => void process.stdout.write(t),
        ask: async (q) => {
          if (values.yes) return true;
          if (!process.stdin.isTTY) {
            process.stdout.write(`${q}\nNo terminal to ask on: re-run with --yes to approve.\n`);
            return false;
          }
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const a = (await rl.question(`${q} [y/N] `)).trim().toLowerCase();
          rl.close();
          return a === 'y' || a === 'yes';
        },
      };
      const need = (what: string) => {
        if (!target) throw new Error(`Usage: browserforge ${area} ${sub} <${what}>`);
        return target;
      };
      const area = positionals[0];
      if (area === 'plugin') {
        switch (sub) {
          case 'add': await commands.pluginAdd(store, need('source'), io); return;
          case 'update': await commands.pluginUpdate(store, need('id'), io); return;
          case 'list': case undefined: commands.pluginList(store, io); return;
          case 'config': await commands.pluginConfig(store, need('id'), rest, io); return;
          case 'new': commands.pluginNew(need('id'), values.dir ?? '.', io); return;
          case 'validate': if ((await commands.pluginValidate(need('folder'), io)).length) process.exitCode = 1; return;
          case 'search': await commands.pluginSearch([target, ...rest].filter(Boolean).join(' '), io); return;
          case 'remove': io.out(store.remove(need('id')) ? `Removed '${target}'. Its data and settings were deleted too.\n` : `No plugin '${target}'.\n`); return;
          case 'enable': case 'disable': io.out(store.setEnabled(need('id'), sub === 'enable') ? `${sub === 'enable' ? 'Enabled' : 'Disabled'} '${target}'. Restart the server to apply.\n` : `No plugin '${target}'.\n`); return;
          default: throw new Error('Usage: browserforge plugin add|list|remove|enable|disable|update|config|new|validate|search');
        }
      }
      switch (sub) {
        case 'add': await commands.skillAdd(cfg.configDir, need('folder'), io); return;
        case 'new': commands.skillNew(need('name'), values.dir ?? '.', io); return;
        case 'list': case undefined: commands.skillList(cfg.configDir, store, io, (d, st) => discoverSkills(d, st, () => undefined)); return;
        case 'export': commands.skillExport(cfg.configDir, need('name'), values.to ?? '.claude/skills', io); return;
        default: throw new Error('Usage: browserforge skill add|list|new|export');
      }
    }
    case 'flow': {
      const cfg = buildConfig(common);
      const recorder = new FlowRecorder(path.join(cfg.configDir, 'flows'), { enabled: false });
      const [sub, id] = [arg, positionals[2]];
      if (sub === 'list' || sub === undefined) {
        const rows = recorder.list();
        process.stdout.write(rows.length ? rows.map((f) => `${f.id}  ${f.saved ? `"${f.name}"` : '(unnamed)'}  ${f.steps} steps, ${f.params} params${f.consequential ? `, ${f.consequential} consequential` : ''}`).join('\n') + '\n' : 'No flows recorded yet. Use BrowserForge on a site and it is saved here automatically.\n');
        return;
      }
      if (sub === 'export') {
        if (!id || !values.format) throw new Error(`Usage: browserforge flow export <id> --format <${BUILTIN_EXPORTERS.map((e) => e.format).join('|')}> [--out FILE] [--defaults]`);
        const flow = recorder.get(id);
        if (!flow) throw new Error(`No flow '${id}'. Run: browserforge flow list`);
        const exporter = getExporter(values.format);
        if (!exporter) throw new Error(`Unknown format '${values.format}'. Available: ${BUILTIN_EXPORTERS.map((e) => e.format).join(', ')}`);
        const code = exporter.generate(flow, { includeDefaults: values.defaults === true });
        if (values.out) fs.writeFileSync(path.resolve(values.out), code);
        else process.stdout.write(code);
        return;
      }
      if (sub === 'consolidate') {
        const site = positionals[2];
        if (!site || !values.name) throw new Error('Usage: browserforge flow consolidate <site> --name "<name>"');
        const flows = recorder.list(site).map((f) => recorder.get(f.id)).filter((f): f is NonNullable<typeof f> => f !== undefined);
        if (flows.length < 2) throw new Error(`Need at least 2 recordings of ${site} (found ${flows.length})`);
        const r = consolidate(flows, { id: `${site}/pending`, name: values.name });
        const saved = recorder.store(r.flow);
        process.stdout.write(`Merged ${flows.length} recordings into ${saved.id} (${r.kept} steps, ${r.dropped} dropped).\n`);
        return;
      }
      if (sub === 'to-skill') {
        if (!id || !values.name) throw new Error('Usage: browserforge flow to-skill <id> --name <skill-name> [--description "..."]');
        const flow = recorder.get(id);
        if (!flow) throw new Error(`No flow '${id}'. Run: browserforge flow list`);
        const r = writeFlowSkill(cfg.configDir, flow, values.name, values.description ?? `Replay the recorded flow on ${flow.site}`);
        process.stdout.write(`Skill written to ${r.dir}\nInputs: ${r.inputs.join(', ') || 'none'}\nRestart the server to load it.\n`);
        return;
      }
      throw new Error('Usage: browserforge flow list | export <id> --format <fmt> [--out FILE] [--defaults] | consolidate <site> --name N | to-skill <id> --name N');
    }
    case 'logs':
    case 'diagnostics': {
      const cfg = buildConfig(common);
      const dir = path.join(cfg.configDir, 'logs');
      const sinceMs = parseSince(values.since ?? (cmd === 'diagnostics' ? '1d' : undefined));
      const fmt = (l: ReturnType<typeof readLogs>[number]) => {
        const { t, level, msg, ...rest } = l;
        return `${t} ${level.toUpperCase().padEnd(5)} ${msg}${Object.keys(rest).length ? ' ' + JSON.stringify(rest) : ''}`;
      };
      if (cmd === 'logs') {
        const lines = readLogs(dir, { sinceMs, minLevel: values.level, tail: values.tail ? Number(values.tail) : 100 });
        process.stdout.write(lines.length ? lines.map(fmt).join('\n') + '\n' : `No log lines in ${dir}${sinceMs ? ' for that period' : ''}. Is the server run with file logging on (the default)?\n`);
        return;
      }
      // A report meant for pasting into a bug: no tokens, no paths outside the config dir, only warnings and errors.
      const problems = readLogs(dir, { sinceMs, minLevel: 'warn', tail: 200 });
      // Which tools cost the calling model the most (from the size of each reply; an estimate, not a bill).
      const perTool = new Map<string, { calls: number; tokens: number; biggest: number; imageBytes: number }>();
      for (const l of readLogs(dir, { sinceMs })) {
        if (l.msg !== 'tool ok' || typeof l.tool !== 'string') continue;
        const t = perTool.get(l.tool) ?? { calls: 0, tokens: 0, biggest: 0, imageBytes: 0 };
        const tk = Number(l.approxTokens) || 0;
        perTool.set(l.tool, { calls: t.calls + 1, tokens: t.tokens + tk, biggest: Math.max(t.biggest, tk), imageBytes: t.imageBytes + (Number(l.imageBytes) || 0) });
      }
      const costly = [...perTool.entries()].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 10);
      const out = [
        `browserforge ${SERVER_VERSION}  node ${process.version}  ${process.platform}`,
        `config dir: ${cfg.configDir}   log dir: ${dir}`,
        `decider: ${cfg.decider.mode} (${cfg.decider.model})   flows: ${cfg.flows.record}   traces: ${cfg.knowledge.traces}   log file: ${cfg.logging.file}`,
        `warnings and errors in the period: ${problems.length}`,
        ...(costly.length ? ['', 'reply size per tool (approx. tokens the model read; ~4 chars each):', ...costly.map(([n, t]) => `  ${n.padEnd(34)} ${String(t.calls).padStart(4)} calls  ${String(t.tokens).padStart(7)} tokens  biggest ${t.biggest}${t.imageBytes ? `  +${Math.round(t.imageBytes / 1024)} KB images` : ''}`)] : []),
        '',
        ...problems.map(fmt),
      ];
      process.stdout.write(out.join('\n') + '\n');
      return;
    }
    case 'doctor': {
      const cfg = buildConfig({ port });
      const base = `http://127.0.0.1:${cfg.port}`;
      const health = await fetch(`${base}/health`).then((r) => r.json()).catch(() => null);
      if (!health) {
        process.stdout.write(`✗ no daemon at ${base}. Start it with: browserforge serve\n`);
        process.exit(1);
      }
      const status = await fetch(`${base}/status`, { headers: { authorization: `Bearer ${cfg.mcpToken}` } }).then((r) => r.json());
      process.stdout.write(JSON.stringify(status, null, 2) + '\n');
      return;
    }
    case 'print-config': {
      const cfg = buildConfig({ port });
      const url = `http://127.0.0.1:${cfg.port}/mcp`;
      if (arg === 'codex') {
        process.stdout.write(`# ~/.codex/config.toml\n[mcp_servers.browserforge]\nurl = "${url}"\nbearer_token_env_var = "BROWSERFORGE_MCP_TOKEN"\n\n# export BROWSERFORGE_MCP_TOKEN="$(cat ${path.join(cfg.configDir, 'mcp-token')})"\n`);
      } else if (arg === 'claude') {
        const file = path.join(cfg.configDir, 'mcp-token');
        const tok = process.platform === 'win32' ? `$((Get-Content "${file}").Trim())` : `$(cat "${file}")`;
        process.stdout.write(`claude mcp add --transport http browserforge ${url} --header "Authorization: Bearer ${tok}"\n`);
      } else throw new Error('print-config needs "codex" or "claude"');
      return;
    }
    default:
      process.stdout.write(USAGE + '\n');
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

