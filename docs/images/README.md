# Картинки для README

Тёмная тема, английский интерфейс. README пакетов ссылаются на картинки абсолютными адресами `raw.githubusercontent.com/NackBard/Nomos/main/docs/images/…`: vsce переписывает относительные ссылки от корня репозитория, а README лежат в подпапках. Поэтому картинки видны на Marketplace только из публичного репозитория и после слияния в `main`. Замена файла под тем же именем меняет страницы Marketplace без выпуска пакетов.

Граф и диаграмма классов сняты на небольшом проекте, на `score/` (9 модулей), и без компактного режима: на большом проекте и в компактном виде картинка читается хуже. Facts — `node analyzers/typescript/src/main.ts analyze --root score --sarif score.sarif > score.facts.json` из корня.

| Файл | Как снят |
|---|---|
| `graph-modules.png` | `extension`: `node scripts/screenshot.mjs --facts score.facts.json --out graph.png --size 1400,820 --flat`, обрезан до 1400×660 |
| `class-diagram.png` | то же с `--module src/core/model --uml --hide type-ref`, обрезан до 1400×655; линии «type use» скрыты, как кнопкой легенды, чтобы видны были связи UML |
| `score-system.png`, `score-charts.png` | на facts всего Nomos (`.nomos/typescript.facts.json` и `.sarif`): в `score/` нет классов, и «Extensibility» там не определена. `score`: `node scripts/screenshot.mjs --facts ../.nomos/typescript.facts.json --sarif ../.nomos/typescript.sarif --out score.png --size 1400,2600`, полосы 0–990 и 995–1855 |
| `score-module.png` | то же с `--module extension/src/core/views --size 1400,1800`, полоса 0–1255 |

Перед съёмкой — `npm run compile` в `extension` и `score`.
