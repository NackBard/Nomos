# Nomos Agents

**Two AI agents that read your code together with the Nomos analysis, and the Nomos MCP server.**

Requires the [Nomos](https://marketplace.visualstudio.com/items?itemName=honestarchitector.nomos) extension, which does the analysis.

> **Preview.** This is the first version of the agents. If an answer looks wrong or something does not start, please [open an issue](https://github.com/NackBard/Nomos/issues).

Like Nomos itself, the agents give observations, not verdicts: each remark names the place, what the agent sees, why it matters, how confident it is and what you could do. No grades, no pass or fail.

## The agents

| Agent | In the chat | What it does |
|---|---|---|
| **Nomos Review** | `@nomos-review` | Checks the code against the paradigms its modules actually use and against the practices you chose |
| **Nomos Performance** | `@nomos-perf` | Estimates the speed of functions and proposes optimizations |

Both take a command that says what to look at:

- `/changes`: only the code you wrote, that is, what differs from the default branch (committed on your branch, uncommitted, new files); on the default branch itself, the uncommitted changes;
- `/all`: all analyzed code, functions with findings first.

Without a command, Review uses `nomosAgents.review.scope` (`changes` by default) and Performance uses `nomosAgents.performance.scope` (`all` by default).

### Nomos Review

Looks at the paradigms its modules use, as Nomos detected them, and at practices and approaches: single responsibility, cohesion and coupling, dependency direction, error handling, immutability, naming, the practices you chose in Nomos.

### Nomos Performance

Proposes another algorithm or data structure, memoization, hoisting work out of loops, batching I/O, with the complexity after the change and when it is not worth it. It starts from the static estimates of Nomos (time `O(n^k log^l n)`, extra memory, allocations in loops): nothing is run and no timings are invented.

Without a chat view, run **Nomos: Agent: Review Paradigms and Practices** or **Nomos: Agent: Speed of Functions** from the Command Palette; the answer opens as a Markdown document.

## The model

Set by `nomosAgents.provider`:

| Value | Model |
|---|---|
| `vscode-lm` (default) | A language model you already have in VS Code, such as GitHub Copilot. In the chat the agents use the model chosen there. |
| `anthropic` | Claude through the Anthropic API with your key. **Nomos: Agents: Set Anthropic API Key** keeps it in the secret storage of VS Code; otherwise `ANTHROPIC_API_KEY` is used. `nomosAgents.anthropic.model` (default `claude-opus-5-5`) and `nomosAgents.anthropic.effort` choose the model and how much it thinks. Requests are billed to your Anthropic account. |

The context sent to the model holds the Nomos data and the source of the selected functions, up to `nomosAgents.contextCharacters`. Functions that do not fit are named in the answer.

## MCP server

The extension registers a Nomos MCP server for each workspace folder, so agent modes that use MCP in VS Code see its tools.

- **Tools**: `nomos_overview`, `nomos_findings`, `nomos_functions`, `nomos_paradigms`, `nomos_changes`, `nomos_hotspots`, `nomos_source`.
- **Prompts**: `review` and `performance`, the same agents for any MCP client and its own model.

Outside VS Code, from a clone of the [Nomos repository](https://github.com/NackBard/Nomos), analyze with `nomos-ci` and start the server on its output:

```
node ci/src/cli.ts --workspace nomos.json --out .nomos
node agents/out/mcp/server.js --snapshot .nomos [--root .] [--locale ru]
```

For example, in Claude Code: `claude mcp add nomos -- node agents/out/mcp/server.js --snapshot .nomos`.

## Links

[Source code](https://github.com/NackBard/Nomos) · [Changelog](https://github.com/NackBard/Nomos/blob/main/agents/CHANGELOG.md) · [Issues](https://github.com/NackBard/Nomos/issues) · MIT License
