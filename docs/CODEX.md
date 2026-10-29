# Using BrowserForge with OpenAI Codex CLI

Codex supports MCP servers over stdio and Streamable HTTP, configured in `~/.codex/config.toml` (`[mcp_servers.<name>]`). The BrowserForge daemon uses Streamable HTTP with a bearer token.

## Configure

1. Start the daemon (`docs/INSTALL.md`).
2. Export the MCP token (not the extension token) in the shell that launches Codex:

   ```bash
   export BROWSERFORGE_MCP_TOKEN="$(cat ~/.config/browserforge/mcp-token)"
   ```

3. Add the server — either with the CLI:

   ```bash
   codex mcp add browserforge --url http://127.0.0.1:7345/mcp --bearer-token-env-var BROWSERFORGE_MCP_TOKEN
   ```

   or by editing `~/.codex/config.toml` (see `examples/codex-config.toml`):

   ```toml
   [mcp_servers.browserforge]
   url = "http://127.0.0.1:7345/mcp"
   bearer_token_env_var = "BROWSERFORGE_MCP_TOKEN"
   ```

   `browserforge print-config codex` prints this block for your port.

4. `codex mcp list` should show `browserforge`. Start `codex` and ask: *"Use browserforge system_status."*

### stdio alternative (one client only)

```toml
[mcp_servers.browserforge]
command = "node"
args = ["/path/to/browserforge/apps/mcp-server/dist/cli.js", "stdio"]
```
In this mode the process Codex launches also listens for the extension on the same port, so the daemon must not already be running.

## Verified

`codex exec` with the server supplied through `-c mcp_servers.browserforge.url=… -c mcp_servers.browserforge.bearer_token_env_var=…` discovered the server and invoked `system_status` successfully (codex-cli 0.163.0). The `rmcp … AuthRequired` line that Codex prints comes from *other* servers in a user's config, not from BrowserForge.

## Client-specific notes

- Codex shows an approval prompt per MCP tool call depending on its approval policy; that is separate from BrowserForge's own in-browser approvals, which always apply.
- Tool output for large pages is truncated by BrowserForge (50 k characters of text by default); ask for narrower views (`browser_get_forms`, `browser_get_interactive_elements`).
