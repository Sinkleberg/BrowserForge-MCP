# Using BrowserForge with Claude Code

Claude Code supports Streamable HTTP MCP servers with custom headers.

## Configure

1. Start the daemon (`docs/INSTALL.md`).
2. Register the server (user scope is convenient; use `--scope project` to share via `.mcp.json`, but the token should then come from an environment variable, not be committed):

   ```bash
   claude mcp add --transport http browserforge http://127.0.0.1:7345/mcp \
     --header "Authorization: Bearer $(cat ~/.config/browserforge/mcp-token)"
   ```

   `browserforge print-config claude` prints this command for your port. A hand-written `.mcp.json` that reads the token from the environment is in `examples/claude-mcp.json` (the `${VAR}` expansion is a documented Claude Code feature but was not exercised here; the literal-header form above was):

   ```json
   { "mcpServers": { "browserforge": { "type": "http", "url": "http://127.0.0.1:7345/mcp",
       "headers": { "Authorization": "Bearer ${BROWSERFORGE_MCP_TOKEN}" } } } }
   ```

3. `claude mcp list` shows the server; inside Claude Code, `/mcp` lists its tools. Try: *"Call browserforge system_status."*

### stdio alternative

```bash
claude mcp add browserforge -- node /path/to/browserforge/apps/mcp-server/dist/cli.js stdio
```

## "Ask the agent" button

The extension popup has a button, **Ask the agent to fill this page** (with an optional note). It tells the connected agent which tab you are looking at; it does nothing to the page itself, and submits, sends and payments still need your approval.

An MCP server cannot start a Claude Code turn on its own, so the request waits on the server until the agent picks it up. Two ways:

1. **Tell Claude** ("I pressed the button"). It calls `browser_pending_requests`, which returns the tab and your note, and works on that tab.
2. **Let Claude watch.** Ask Claude Code once: *"Run `browserforge watch` with the Monitor tool and act on each ASK line."* The command prints one line per press (`ASK #3 tab 42 note: ...`), which wakes Claude, and Claude then calls `browser_pending_requests`. It only prints the id, tab and your own note, never page text.

Requests are kept in memory (the last 30) and are lost when the daemon restarts. Reload the extension after updating so the popup shows the button.

## Verified

With `claude -p … --mcp-config .mcp.json --strict-mcp-config --allowedTools mcp__browserforge__system_status` (Claude Code 2.1.310) the server was discovered and `system_status` returned `server=browserforge-mcp version=0.1.0`.

## Client-specific notes

- Project-scoped servers from `.mcp.json` require interactive approval the first time (`claude mcp list` shows "Pending approval"). That is a Claude Code safety feature, unrelated to BrowserForge.
- Tools are exposed as `mcp__browserforge__<tool>`; pre-approve read-only ones with `--allowedTools` if you like, but leave `browser_click`, `browser_type`, `browser_fill_form` and `workflow_run` on prompt.
- Claude Code can display the screenshots returned by `browser_take_screenshot`.
