# Дорожная карта

Порядок этапов определён в D-020. Этап считается завершённым, когда выполнены все пункты «Готово, когда». Чем раньше фиксируется контракт, тем дешевле каждый следующий этап: расширение и второй язык строятся против него.

Общее ограничение всех этапов: платформа даёт статистику. Пороги приёмки и вердикты не вводятся.

Состояние: этапы 1–4 завершены (D-031, D-032, D-034). Следующий — этап 5.

Как проверить, что всё на месте: `dotnet test Nomos.slnx` в `analyzers/csharp`; `npm run validate`, `npm test`, `npm run selftest`, `npm run csharp` в `conformance/runner`; `npm test`, `npm run check-boundary`, `npm run e2e` в `extension`. CI (`.github/workflows/ci.yml`) зелёный на `main`, он запускается на Ubuntu и Node 22.18 (D-035), его результат смотрит `gh run list`.

## Этап 1. Контракты, spec, conformance-harness

- `contracts/`: схемы manifest, facts, правила, nomos.json, conformance-case; профиль SARIF.
- `spec/`: `rules/*.yaml`, `metrics.md`, `paradigms.md`.
- `conformance/runner`: запускает анализатор, проверяет схемы, сравнивает facts с допусками, проверяет parity между языками.
- Первые случаи: `metrics-basic`, `coupling-martin`, `cycles`, `paradigm-evidence`.
- Валидация `spec/rules/*.yaml` по `rule.schema.json` в CI.

Готово, когда: схемы проходят метавалидацию; harness запускается на «пустом» анализаторе-заглушке и сообщает понятные ошибки; случаи имеют эталоны, посчитанные вручную по `spec/metrics.md`.

## Этап 2. Анализатор C#

- Перенос существующих проектов в `analyzers/csharp` (раздел «Миграция» ниже).
- Команды `manifest` и `analyze`, коды возврата из ARCHITECTURE.md.
- Facts: модули, типы, функции, зависимости, метрики, `cycles`, `paradigmEvidence`, `skippedRules`, `health`.
- SARIF для Principles и CleanCode (ООП): PRN001–PRN009, CC001–CC009, `CS.NAM001`.
- Прохождение всех случаев conformance этапа 1.

Готово, когда: harness зелёный для C#; вывод детерминирован; `skippedRules` содержит `paradigm-not-detected` для модулей без классов.

## Этап 3. Расширение: дерево проблем и граф

- Каркас `extension/`, чтение `nomos.json`, запуск анализатора, проверка по схемам.
- Дерево проблем из SARIF, Diagnostics, CodeLens с метриками.
- Граф модулей и типов из facts (webview), подсветка циклов.
- Показ признаков парадигм и пропущенных правил.

Готово, когда: расширение работает с C# без единой строки языко-специфичного кода (проверяется поиском по `extension/`); открытие проекта на другом языке — только через `nomos.json`.

## Этап 4. Парадигмы

- Функциональная и структурная парадигмы: FUN001–FUN005, STR001–STR003, OOP001–OOP006.
- Расчёт и вывод `paradigmEvidence`, точное условие применимости; пороги активации в `spec/paradigms.md`.
- Анализ признаков стиля: сколько модулей какого стиля, в расширении.

Завершён, D-034: `activeParadigms` в facts (контракт 1.1.0), записи `disabled-by-config`, метрики `hofOrder`, `lambdaNesting`, `typeTests`, `measured` у FUN005, OOP003, STR003, случай `paradigm-activation`, сводка «Modules by style» в расширении.

## Этап 5. Algorithms и Design

- ALG001–ALG004.
- DSN001–DSN006, включая God class, Feature envy, blast radius; DSN003 по `layers`.
- Случаи conformance для `blast-radius`, `cycles` на сложных графах.

Отправная точка (на момент завершения этапа 4):

- Уже есть: детекторы ALG001–ALG004 и DSN001–DSN006 с фикстурами и записью в `spec/rules`; метрики `blastRadius`, `atfd`, `tcc`, Мартина в facts; случай `cycles` на простом графе; `layers` в `nomos.json`, которые читает `WorkspaceFile`.
- `measured` есть у DSN001, DSN004, DSN006. Нет у ALG001, ALG003, ALG004 и DSN005, у которых в spec есть пороги: оценка сложности и `minForeignMembers` пока не определены в `spec/metrics.md` и не выводятся в facts. По D-034 сначала определение в spec и вывод в facts, затем `measured`.
- Нет случаев conformance с `blast-radius` и `cycles` на сложных графах; DSN003 не проверялся через `nomos.json` в conformance, потому что harness не передаёт `--config`, а в `case.json` нет такого поля. Новое поле — изменение контракта.
- Blast radius считается обходом на каждый тип, квадратично (D-028); на больших графах это не проверено (D-030).

Перенесено с прошлых этапов, вне состава этапа 5, решать отдельно:

- Балл здоровья нормируется на `LinesOfCode` из IR, а spec требует `loc` модуля (D-034); исправление меняет все баллы.
- OOP006 смотрит только на классы, записи не учитывает (D-034).
- Панель графа и деревья расширения, включая «Modules by style», глазами не проверены (D-032, D-034).
- В CI действия `checkout`, `setup-dotnet`, `setup-node` версии 4 предупреждают об устаревшем Node 20; `npm ci` в harness сообщает о двух уязвимостях средней серьёзности (D-035).

## Этап 6. Patterns, Maintainability, Security

- PAT001–PAT007, PAT101–PAT103.
- MNT001–MNT004 (покрытие из Cobertura/LCOV).
- SEC001–SEC003 как эвристики, с честной пометкой о границах.

## Этап 7. Второй язык

- Язык выбирается отдельным решением (открытый вопрос в DECISIONS.md).
- Анализатор на родных средствах языка, всё через те же контракты.
- Прохождение всех случаев conformance; фиксация исключений в `case.json`.
- `docs/EXTENDING.md` проверяется на практике и исправляется по итогам.

## Этап 8. Отчёты и CI-режим

- Отчёты md/html из facts и SARIF (по образцу прежнего Reporting).
- CI-режим: запуск без IDE по `nomos.json`, выгрузка SARIF и facts, сравнение с предыдущим запуском (baseline по fingerprint).
- Режим только сообщает: код возврата не зависит от числа находок и значения балла (D-021).

## Миграция существующего .NET-кода (часть этапа 2)

1. ~~Создать `analyzers/csharp/`, перенести туда `src/` и `tests/` (с пересборкой ссылок в `Directory.Build.props`, `Directory.Packages.props`, `Nomos.slnx`).~~ Сделано, D-027.
2. ~~Добавить слой «facts + SARIF»: по IR строится facts; существующие находки превращаются в SARIF по профилю.~~ Сделано, D-028 (`Nomos.Facts`, `Nomos.Analyzer.CSharp`); четыре случая conformance проходят.
3. ~~Привязать id анализаторов к `spec/rules`; `CC005` становится `CS.NAM001`.~~ Сделано, D-031.
4. ~~Заменить `Cli` на протокол `manifest`/`analyze`; удалить рефлексивный поиск плагинов и `Languages.TreeSitter`.~~ Сделано, D-031.
5. ~~Перегенерировать golden-файлы; после этого — удалить дубли, не используемые больше.~~ Сделано, D-031.

Ни один шаг не удаляет работающий код до того, как его замена проходит conformance.
