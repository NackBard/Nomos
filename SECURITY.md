# Security

[Русская версия](SECURITY.ru.md)

## Reporting a vulnerability

Please do not open a public issue. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/NackBard/Nomos/security/advisories/new):
what is affected, how to reproduce it, and which version. You will get an answer within a week; a fix is released as a
new version of the affected packages on the Visual Studio Marketplace.

Supported versions: the latest published version of each package. Older versions get no fixes.

## What Nomos runs

Nomos reads code and runs programs, so it is worth knowing which:

- **The core** runs the analyzers. Without `nomos.json` they come from the installed language packs; with it, the
  `command`, `cwd` and `env` of each analyzer in `nomos.json` are run as written. Runtimes (Python, Java, Ruby, .NET) are
  found through other extensions, settings, environment variables and `PATH`.
- **Nomos Agents** run `git` in the folder (with the file system monitor turned off) and send the analysis and the code
  of the chosen functions to the language model you configure: one of VS Code, or the Anthropic API with your key, kept
  in the secret storage of VS Code. The MCP server only reads the analysis snapshot and files under the analyzed root.
- **Nomos Score** runs nothing; it shows the core's analysis.
- **`nomos-ci`** runs the analyzers of `nomos.json` in your pipeline.

None of the extensions works in an untrusted folder ([Workspace Trust](https://code.visualstudio.com/docs/editor/workspace-trust)):
VS Code keeps them disabled there until you trust the folder. Trust a folder only when you trust its `nomos.json` and
its workspace settings. The analyzers themselves parse source text and run none of the analyzed code.
