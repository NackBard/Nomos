# Nomos

> Прежнее название — DeepCode.Analizer (D-024).

Платформа статического осмотра исходного кода: принципы проектирования, парадигмы, сложность алгоритмов, архитектура, паттерны, чистота кода, базовая безопасность. Поддерживаются C#, Go, TypeScript и JavaScript.

Все выводы — эвристики: у каждой находки есть уровень уверенности и объяснение. Платформа даёт статистику для анализа разработчиком, порогов приёмки нет.

Устройство (D-020): отдельные анализаторы по языкам, контракты в `contracts/`, расширение VS Code в `extension/`. См. [ARCHITECTURE](docs/ARCHITECTURE.md) и [ROADMAP](docs/ROADMAP.md). Расширение несёт анализаторы C#, Go, TypeScript и JavaScript с собой и работает в любой папке, `nomos.json` необязателен: `npm run package -- --target win32-x64` в `extension/` собирает `.vsix` (D-046).

## Быстрый старт

Нужен .NET SDK 10.

```powershell
cd analyzers/csharp
dotnet build Nomos.slnx
dotnet test Nomos.slnx

dotnet run --project src/Nomos.Analyzer.CSharp -- manifest
dotnet run --project src/Nomos.Analyzer.CSharp -- analyze --root tests/fixtures/golden/sample-project --sarif nomos.sarif > facts.json
```

Facts печатаются в stdout, находки пишутся в файл SARIF.

## Протокол

```
nomos-csharp manifest
nomos-csharp analyze --root <путь> [--sarif <файл>] [--config <nomos.json>] [--rules <id,id>]
```

Коды выхода: 0 — успех, 1 — непредвиденная ошибка, 2 — ошибка использования, 3 — входные данные не годятся, 4 — частичный результат. Число находок и балл на код не влияют.

## Документация

- [Архитектура и конфигурация](docs/ARCHITECTURE.md)
- [Каталог правил](docs/ANALYZERS.md)
- [Как добавить анализатор, язык, парадигму](docs/EXTENDING.md)
- [Журнал решений и отложенные задачи](docs/DECISIONS.md)
