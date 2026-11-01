# Conformance

Анализаторы пишутся независимо, на разных языках. Чтобы одинаковые метрики оставались одинаковыми, каждый анализатор обязан пройти эти тесты. Без них дублирование формул между языками дрейфовало бы незаметно.

## Структура

```
conformance/
  README.md
  runner/                          # harness (этап 1): запускает анализаторы, сравнивает, проверяет схемы
  cases/
    <case-id>/
      case.json                    # contracts/conformance-case.schema.json
      <язык>/
        src/                       # исходники на этом языке
        expected.facts.json        # ожидаемый facts, проверяется по contracts/facts.schema.json
        expected.sarif.json        # только если case.json: expectSarif = true
```

Один случай — один сценарий, реализованный на каждом языке с одинаковой формой: те же модули, те же зависимости, те же ветвления. Исходники пишутся так, чтобы ожидаемые числа совпадали между языками; места, где язык вносит отличие (например, `object` как корень), описаны в `case.json` и в `expected.facts.json` этого языка.

## Что проверяет harness

1. `<analyzer> manifest` соответствует `manifest.schema.json`; набор `rules[].id` равен `capabilities.supportedRules`; все id существуют в `spec/rules` или имеют префикс языка.
2. `<analyzer> analyze --root cases/<id>/<язык>/src` даёт документ, валидный по `facts.schema.json`.
3. Фактический facts совпадает с `expected.facts.json`: сущности сопоставляются по `id`, метрики — по допускам `case.json` (`spec/metrics.md`, раздел «Допуски»). Лишние сущности — ошибка, отсутствующие — ошибка. Порядок массивов не сравнивается, но вывод обязан быть детерминированным (два запуска побайтово равны).
4. Для каждого пункта `parity` значение метрики совпадает у всех перечисленных языков.
5. SARIF проверяется по профилю (`contracts/sarif-profile.md`) для каждого случая; официальная схема SARIF 2.1.0 проверяется, если скачана командой `npm run fetch-sarif-schema` (копии в репозитории нет, D-029). При `expectSarif` множество `(ruleId, файл, startLine)` совпадает с эталоном `expected.sarif.json` вида `{ "results": [{ "ruleId": "CC001", "file": "A.cs", "startLine": 12 }] }`.
   Манифест сверяется со spec: парадигмы и категория каждого общего правила равны записи в `spec/rules`.
6. Применимость: `activeParadigms` следуют из признаков с отметкой «да» в таблицах `spec/paradigms.md`; правило без активной парадигмы имеет запись `paradigm-not-detected`, а правило с активной её не имеет.

## Запуск

```powershell
cd conformance/runner
npm install
npm run validate     # контракты, spec/rules, случаи и их эталоны
npm test             # самопроверка сравнения
npm run selftest     # эхо-анализатор: путь успеха harness
npm run rules-doc    # пересобрать docs/ANALYZERS.md из spec/rules
npm run csharp       # собранный анализатор C#: dotnet build analyzers/csharp/Nomos.slnx, затем harness на всех случаях
node src/cli.ts run --analyzer "csharp=<команда>" [--case cycles]
```

Правила сравнения и принятые границы случаев — D-026 в `docs/DECISIONS.md`. Код возврата harness (0/1) относится к самому harness; на коды возврата анализаторов он не влияет.

## Набор случаев (план этапа 1)

Готовы (только C#, эталоны посчитаны вручную): `metrics-basic`, `coupling-martin`, `cycles`, `paradigm-evidence`, `oop-cohesion`, `partial-failure`. Остальные — позже.

Код возврата анализатора в `run` не задаётся в `case.json`: он выводится из эталона. Если в `expected.facts.json` есть файл с `parsed: false`, ожидается код 4 (частичный результат), иначе 0.

| Случай | Что покрывает |
|---|---|
| `metrics-basic` | `lines`, `loc`, `parameterCount`, `cyclomatic`, `maxNesting` на функциях с известной структурой |
| `coupling-martin` | `ca`, `ce`, `instability`, `abstractness`, `distance` на трёх модулях |
| `cycles` | `cycles` уровней type и module, ребро `type-only` |
| `oop-cohesion` | `dit`, `cbo`, `lcom4`, `wmc` |
| `blast-radius` | `blastRadius` на цепочке и ромбе зависимостей |
| `paradigm-evidence` | признаки `oop.*`, `fp.*`, `str.*`; запись `paradigm-not-detected` для модуля без классов |
| `paradigm-activation` | точные `activeParadigms`: лямбды и глобальное состояние сами по себе ничего не активируют; `disabled-by-config`; `hofOrder`, `lambdaNesting`, `typeTests`, `measured` у OOP003 |
| `health` | балл здоровья и разбивка при заданных результатах |
| `partial-failure` | файл с синтаксической ошибкой: код возврата 4, `parsed: false`, `diagnostics` |

## Как добавить случай

1. Создайте `cases/<id>/case.json` и перечислите языки.
2. Напишите исходники для **каждого** языка, который уже есть. Случай, который проходит только один язык, не является conformance-случаем.
3. Получите `expected.facts.json` вручную по `spec/metrics.md` и сверьте глазами. Эталон нельзя сгенерировать из вывода проверяемого анализатора: тогда тест подтверждал бы сам себя.
4. Запустите harness для всех анализаторов.

## Новый язык

Анализатор нового языка считается готовым к подключению, когда проходит все существующие случаи. Если случай по природе языка не выразим (например, наследование в языке без классов), в `case.json` фиксируется исключение с причиной.
