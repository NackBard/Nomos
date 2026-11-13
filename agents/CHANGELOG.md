# Changelog

## 0.1.0

First release, marked as a preview: the agents are new and will change with your feedback.

- **Nomos Review** (`@nomos-review`): checks the code against the paradigms its modules use and the practices you chose; `/changes` for the code that differs from the default branch, `/all` for all analyzed code.
- **Nomos Performance** (`@nomos-perf`): static estimates of how fast functions are, with suggestions to speed them up.
- The model is the one VS Code gives, or Claude through your own Anthropic API key.
- **Nomos MCP server**: tools over the last analysis and the prompts of both agents, for the Copilot agent mode, Claude Code and other MCP clients.
- Requires the Nomos extension. With Nomos 0.1.1 or newer, the snapshot for the MCP server is refreshed after each analysis.
