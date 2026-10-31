# Examples

| | |
|---|---|
| [`plugins/hello`](plugins/hello) | The smallest plugin: a tool, private notes in its own folder, untrusted wrapping |
| [`skills/hello`](skills/hello) | The smallest skill: instructions plus a templated workflow |
| `claude-mcp.json`, `codex-config.toml` | Connecting Claude Code or Codex to a running server |

Try them:

```bash
browserforge plugin add ./examples/plugins/hello
browserforge skill add ./examples/skills/hello
```

Real-world references: [`plugins/rendercv`](../plugins/rendercv) and [`skills/job-apply`](../skills/job-apply). Guides: [docs/PLUGINS.md](../docs/PLUGINS.md), [docs/SKILLS.md](../docs/SKILLS.md).
