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

## Verified

With `claude -p … --mcp-config .mcp.json --strict-mcp-config --allowedTools mcp__browserforge__system_status` (Claude Code 2.1.310) the server was discovered and `system_status` returned `server=browserforge-mcp version=0.1.0`.

## Client-specific notes

- Project-scoped servers from `.mcp.json` require interactive approval the first time (`claude mcp list` shows "Pending approval"). That is a Claude Code safety feature, unrelated to BrowserForge.
- Tools are exposed as `mcp__browserforge__<tool>`; pre-approve read-only ones with `--allowedTools` if you like, but leave `browser_click`, `browser_type`, `browser_fill_form` and `workflow_run` on prompt.
- Claude Code can display the screenshots returned by `browser_take_screenshot`.
