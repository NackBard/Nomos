# Nomos

> Прежнее название — DeepCode.Analizer (D-024). Проекты и пространства имён уже переименованы в `Nomos.*`; перенос папок в `analyzers/csharp` — этап 2.

Расширяемая платформа статического осмотра исходного кода: принципы проектирования, парадигмы, сложность алгоритмов, архитектура, паттерны, чистота кода, базовая безопасность. Первый поддерживаемый язык — C#.

Все выводы — эвристики: у каждой находки есть уровень уверенности и объяснение. Платформа даёт статистику для анализа разработчиком, порогов приёмки нет.

> Архитектура меняется (D-020): отдельные анализаторы по языкам, контракты в `contracts/`, расширение VS Code в `extension/`. См. [ARCHITECTURE](docs/ARCHITECTURE.md) и [ROADMAP](docs/ROADMAP.md). Описанный ниже .NET-CLI — текущая реализация, она переедет в `analyzers/csharp`.

## Быстрый старт

Нужен .NET SDK 10.

```powershell
dotnet build Nomos.slnx
dotnet test Nomos.slnx

dotnet run --project src/Nomos.Cli -- analyze tests/fixtures/golden/sample-project --format md,html,json,sarif
```

Отчёты появятся в `nomos-report/`. Анализировать можно папку, `.sln`, `.slnx` или `.csproj`.

## CLI

```
nomos analyze <path> [--config f] [--format md,html,json,sarif] [--output dir]
                         [--plugins dir] [--quiet]
nomos list-analyzers
nomos init [folder]
```

Коды выхода: 0 — успех, 1 — не пройден порог качества, 2 — ошибка запуска или конфигурации.

## Документация

- [Архитектура и конфигурация](docs/ARCHITECTURE.md)
- [Каталог анализаторов](docs/ANALYZERS.md)
- [Как добавить анализатор, язык, парадигму](docs/EXTENDING.md)
- [Журнал решений и отложенные задачи](docs/DECISIONS.md)
