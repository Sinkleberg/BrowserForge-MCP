#!/usr/bin/env node

import path from 'node:path';
import { parseArgs } from 'node:util';
import { createApp } from './app.js';
import { SERVER_VERSION, buildConfig } from './context.js';

const USAGE = `browserforge ${SERVER_VERSION} — local MCP server for the BrowserForge browser extension

Usage:
  browserforge serve  [--port N] [--allow-reveal] [--allow-dir DIR]...   Run the daemon (MCP over HTTP + extension WebSocket)
  browserforge stdio  [--port N] [--allow-reveal] [--allow-dir DIR]...   MCP over stdio; also listens for the extension
  browserforge tokens                                                    Print token file locations (and the extension token)
  browserforge doctor [--port N]                                         Check a running daemon
  browserforge print-config <codex|claude> [--port N]                    Print client configuration snippets

Local decider (browser_run_goal): [--decider-url http://127.0.0.1:11434] [--decider-model qwen3:4b-instruct] [--no-traces] [--trace-retention-days N]

Environment: BROWSERFORGE_DECIDER_URL, BROWSERFORGE_DECIDER_MODEL, BROWSERFORGE_NO_TRACES=1, BROWSERFORGE_PORT, BROWSERFORGE_HOME, BROWSERFORGE_ALLOW_REVEAL=1, BROWSERFORGE_ALLOW_DIRS, BROWSERFORGE_LOG=debug|info|warn|error`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      'allow-reveal': { type: 'boolean' },
      'allow-dir': { type: 'string', multiple: true },
      'decider-url': { type: 'string' },
      'decider-model': { type: 'string' },
      'no-traces': { type: 'boolean' },
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
    ...(values['decider-url'] || values['decider-model'] ? { decider: { url: values['decider-url'] ?? '', model: values['decider-model'] ?? '', minConfidence: 0.7, timeoutMs: 90_000 } } : {}),
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
    case 'tokens': {
      const cfg = buildConfig({ port });
      process.stdout.write(`Config dir      : ${cfg.configDir}\nExtension token : ${cfg.extensionToken}\n  (paste into the BrowserForge extension popup)\nMCP token file  : ${path.join(cfg.configDir, 'mcp-token')}\n  (used as Bearer token by Codex / Claude Code; never paste it into a web page)\n`);
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
        process.stdout.write(`claude mcp add --transport http browserforge ${url} --header "Authorization: Bearer $(cat ${path.join(cfg.configDir, 'mcp-token')})"\n`);
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

