# Анализатор Go

Команды здесь же: `go vet ./...`, `go test ./...`. Решения — D-038.

Текст правил и практик он берёт из `internal/analyzer/rules.json` и `practices.json` (сгенерированы, в поиск не попадают): после правки `spec/rules` или `spec/practices.yaml` запустите `npm run spec-json` и `npm run rules-doc` в `conformance/runner`. Тексты находок — `tx(формат, …)`; `TestTemplatesAreInSpec` читает их из исходников и ищет в spec (D-052).
