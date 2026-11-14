# Расширение VS Code

```powershell
npm install
npm test                # сборка и тесты src/core, без VS Code
npm run check-boundary  # нет языко-специфичного кода
npm run check-l10n      # у каждой строки расширения, ci, правила и практики есть русский текст
npm run e2e             # настоящий VS Code на этом репозитории
npm run e2e -- <папка без nomos.json>   # со встроенными анализаторами, нужен bundle
npm run package -- --target win32-x64  # dist/: ядро и языковые пакеты; --only <части>, --bundle-only — только bundle/ и packs.json
npm run e2e -- <папка> --packs          # ядро и пакеты из dist/ установлены в профиль
node scripts/check-packs.mjs [--target <цель>] [--require go,typescript]   # пакеты из dist/ на этой машине: анализ образца conformance; в CI — .github/workflows/packages.yml
```

Данные графа строятся в `src/core/views.ts` (`buildGraph`, `buildFocus`), диаграмма классов и её выгрузка — в `src/core/uml.ts`, рисует их `media/graph.js`, разметка страницы — `src/ui/graphPage.ts` (без `vscode`, её можно отрисовать в браузере). Страницу webview e2e не нажимает: раскладку проверяйте скриншотом с реальными facts, `node scripts/screenshot.mjs --facts <facts.json> --out <png> [--module <id>] [--hover <имя>] [--hide <виды>] [--theme light] [--locale ru] [--uml] [--flat] [--open <папки>] [--limit N] [--expand]` после `npm run compile` (D-044, D-045, D-047). Компактный вид — D-064: свёртка по папкам в `buildGraph`, пучки и стволы в `graph.js`.

Строки интерфейса проходят через `t("…")` с литералом и переводятся в `l10n/bundle.l10n.ru.json`; тексты `package.json` — `%ключи%` `package.nls*.json` (D-052). Находки в редакторе по умолчанию — неяркие подсказки, вид задаёт `nomos.diagnostics` (D-054). Без `nomos.json` настройка идёт из настроек VS Code (D-050), анализаторы — из `package.json` установленных языковых пакетов (ключ `nomos`), затем из своего `bundle/analyzers.json` для разработки (D-046, D-062). Предложить пакет ядро может по `packs.json`.
