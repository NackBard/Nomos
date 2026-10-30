# Профиль SARIF 2.1.0

Результаты проверок передаются в SARIF 2.1.0 (OASIS). Собственного формата для находок нет. Этот файл фиксирует, какие поля обязательны и как они заполняются. Профиль входит в контракт версии `1.0.0`: изменение требует увеличения `schemaVersion` и записи в `docs/DECISIONS.md`.

Файл пишется командой `analyze --sarif <файл>`. Валидация выполняется официальной схемой SARIF 2.1.0 плюс правилами ниже (проверяет conformance-harness).

## Обязательные поля

| Поле SARIF | Содержимое |
|---|---|
| `runs[0].tool.driver.name`, `version` | `name` и `version` из manifest |
| `runs[0].tool.driver.rules[]` | по одному элементу на каждое правило из `supportedRules`: `id`, `name` = title, `shortDescription`, `fullDescription` = rationale, `defaultConfiguration.level`, `properties.category`, `properties.paradigms` |
| `results[].ruleId` | Id правила из `spec/rules` |
| `results[].level` | `info` → `note`, `minor` → `warning`, `major` → `warning`, `critical` → `error`. Исходная серьёзность в `properties.severity` |
| `results[].message.text` | Короткое утверждение о коде, на английском |
| `results[].locations[0].physicalLocation` | `artifactLocation.uri` — путь относительно `--root` с прямыми слэшами, `region.startLine` и далее по возможности |
| `results[].partialFingerprints["nomos/v1"]` | Хэш, не зависящий от номера строки: ruleId + id сущности + нормализованное сообщение |
| `results[].properties.confidence` | `low`, `medium` или `high`. Обязательно: любая находка — эвристика |
| `results[].properties.explanation` | Непустое объяснение, почему это может быть проблемой и чем оно ограничено. Результат без объяснения недопустим |
| `results[].properties.module` | Id модуля, если определён |
| `results[].properties.entity` | Id типа или функции, если определён |
| `results[].properties.measured` | Измеренное значение и порог: `{ "value": 52, "threshold": 40, "metric": "lines" }`, если правило основано на числе |

## Запреты

- В SARIF нет времени, абсолютных путей и случайных идентификаторов: вывод детерминирован.
- `results` отсортированы по `(uri, startLine, startColumn, ruleId, message)` в порядке ordinal.
- Ни один результат не означает «провал»: находки не влияют на код возврата анализатора.
- Правила, пропущенные из-за отсутствия признака парадигмы, не порождают результатов; они перечисляются в `skippedRules` документа facts.
