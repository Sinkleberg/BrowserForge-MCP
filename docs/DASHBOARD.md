# Dashboard

A read-only page that shows what your BrowserForge has installed and what it is doing: connected browsers, MCP sessions and tools, plugins (with the permissions you approved), skills, recorded flows and the local models.

```bash
browserforge serve          # in one terminal
browserforge dashboard      # opens http://127.0.0.1:7345/dashboard in your browser
browserforge dashboard --print   # only print the address
```

On Windows, use the *BrowserForge dashboard* entry in the Start menu.

| Tab | Shows |
|---|---|
| **Overview** | Server version and uptime, connected browsers (and which extension version), open MCP sessions, how many tools, plugins, skills and flows there are |
| **MCP** | How to connect an agent, and every tool grouped by area (`browser`, `network`, `api`, ...) or by plugin, filterable, with read-only tools marked |
| **Plugins** | Each plugin loaded, skipped (and why) or switched off, with what it may do in plain words and the tools it adds |
| **Skills** | Each skill, what it needs, and its ready-made workflows with their inputs |
| **Flows** | The 20 newest recorded flows: site, steps, parameters, how many steps need approval, outcome, replays |
| **Local models** | Whether Qwen (Ollama) and Laya (Ollaya) are reachable, and the scorecard of who decided how many steps and how often those runs were good or bad |

It refreshes every 5 seconds. It changes nothing: each page shows the terminal command for the change you may want (`browserforge plugin disable <id>`, `browserforge flow export ...`).

## How it stays safe

* The page and its two files carry no data. The data comes from `/dashboard/data`, which needs the **dashboard token**: a third secret, `dashboard-token` in your settings folder, separate from the MCP token and the extension token. The MCP token does not open the dashboard, and the dashboard token opens nothing else.
* `browserforge dashboard` puts the token in the address after a `#`. A browser never sends that part to a server; the page keeps it for that tab only and removes it from the address bar.
* Only the page itself may call the data address: a request from any other website is refused, as is any request whose `Host` is not the loopback address (DNS rebinding).
* A strict Content-Security-Policy allows nothing but the page's own two files, and it cannot be put in a frame. Text that comes from plugins, skills or flows is shown as plain text, never as HTML.
* It never shows tokens, secrets, typed values, page content or your profile.

Tests: [tests/integration/dashboard.test.ts](../tests/integration/dashboard.test.ts), [tests/security/dashboard.test.ts](../tests/security/dashboard.test.ts).

## Next

Version 2 should let you switch a plugin on or off from the page, with the approval in the browser extension as for every other consequential action. That is on the [roadmap](https://github.com/users/zoghlamimostafa/projects/1) (issue #7).
