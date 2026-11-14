# Анализатор TypeScript и JavaScript

Один код, два языка: `node src/main.ts [--language javascript] manifest | analyze --root …`. Команды здесь же: `npm test`, `npm run typecheck`. Решения — D-055.

Читает `src/rules.json` и `src/practices.json` из `npm run spec-json` (сгенерированы, в поиск не попадают); тексты находок — `tx("шаблон spec", …)`, их проверяет `text.test.ts`. Модуль — файл, циклы — только по рёбрам `runtime`. В пакет попадает через `${node}` реестра (Node самого VS Code). Все случаи для двух языков — `npm run typescript` в `conformance/runner`.
