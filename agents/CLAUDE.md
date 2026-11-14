# Агенты и MCP-сервер (D-063)

```powershell
npm install
npm test                 # сборка и тесты src/core и src/mcp, без VS Code (нужен git)
npm run package          # dist/nomos-agents-<версия>.vsix
node out/mcp/server.js --snapshot ../.nomos   # сервер на выводе nomos-ci
```

`src/core` и `src/mcp` не импортируют `vscode`: их проверяют модульные тесты и ими же пользуется MCP-сервер. Контекст агентов собирает `core/agents.ts` (`buildRequest`), инструкции — `core/prompts.ts`: они на английском для модели, язык ответа — отдельной строкой. Агенты не дают оценок и вердиктов (D-021). Строки интерфейса — `t("…")` с переводом в `l10n/bundle.l10n.ru.json`, тексты `package.json` — `package.nls*.json`; их проверяет `npm run check-l10n` в `extension`, языковую границу — `npm run check-boundary` там же.

Данные — `NomosApi.runs()` ядра; после `onDidAnalyze` снимок пишется в `globalStorage/snapshots/<хеш папки>/`, его читает MCP-сервер. `@anthropic-ai/sdk` грузится только при `nomosAgents.provider = anthropic`.
