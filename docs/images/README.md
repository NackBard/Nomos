# Картинки для README

Скриншоты страниц графа и Score на facts самого Nomos (`.nomos/typescript.facts.json` и `.sarif`), тёмная тема, английский. README пакетов ссылаются на них абсолютными адресами `raw.githubusercontent.com/NackBard/Nomos/main/docs/images/…`: vsce переписывает относительные ссылки от корня репозитория, а README лежат в подпапках. Поэтому картинки видны на Marketplace только из публичного репозитория и после слияния в `main`.

| Файл | Как снят |
|---|---|
| `graph-modules.png` | `extension`: `node scripts/screenshot.mjs --facts ../.nomos/typescript.facts.json --out graph.png --size 1400,820`, обрезан до 1400×720 |
| `class-diagram.png` | то же с `--module extension/src/core/uml --uml`, обрезан до 1400×650 |
| `score-system.png`, `score-charts.png` | `score`: `node scripts/screenshot.mjs --facts ../.nomos/typescript.facts.json --sarif ../.nomos/typescript.sarif --out score.png --size 1400,2600`, полосы 0–990 и 995–1855 |
| `score-module.png` | то же с `--module extension/src/core/views --size 1400,1800`, полоса 0–1255 |

Перед съёмкой — `npm run compile` в `extension` и `score`.
