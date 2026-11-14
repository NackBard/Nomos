# Баллы и панели (D-065)

```powershell
npm install --offline   # те же версии, что у ядра
npm test                # сборка и тесты src/core, без VS Code
npm run package         # dist/nomos-score-<версия>.vsix
node scripts/screenshot.mjs --facts ../.nomos/go.facts.json --sarif ../.nomos/go.sarif --out <png> [--module <id> | --unit <id>] [--theme light] [--locale ru] [--size W,H]
```

Формулы — `spec/score.md`, сначала spec, потом код. `src/core` без `vscode`: граф единиц и перколяция (`graph.ts`), баллы и недобор (`score.ts`), данные страницы (`dashboard.ts`). Страница — `src/ui/page.ts`, рисует `media/score.js`, слов в нём нет: тексты приходят из `src/ui/strings.ts`. Эталоны тестов считаются вручную. Скриншоту нужен `npm run compile` и здесь, и в `extension` (для SARIF).

Ядро вызывает `nomos.inspect.command` из `package.json` на двойной щелчок по узлу графа; других связей с ядром нет, данные — `NomosApi.runs()` и `onDidAnalyze`. Строки — `t("…")` с переводом в `l10n/bundle.l10n.ru.json`; `check-l10n` и `check-boundary` в `extension` проверяют и этот пакет.
