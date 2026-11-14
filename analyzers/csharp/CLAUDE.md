# Анализатор C#

`analyzers/csharp/src`, `analyzers/csharp/tests`, .NET 10 / C# 14. Все команды `dotnet` выполняются из `analyzers/csharp`. Входная точка — `Nomos.Analyzer.CSharp` (`nomos-csharp`), говорит по протоколу `manifest`/`analyze` (D-031).

## Команды

```powershell
dotnet build Nomos.slnx
dotnet test Nomos.slnx

# Один проект, один анализатор, один тест
dotnet test tests/Nomos.Analyzers.Tests
dotnet test tests/Nomos.Analyzers.Tests --filter "DisplayName~CC001"
dotnet test tests/Nomos.Core.Tests --filter "FullyQualifiedName~EngineTests.Glob_HandlesSegments"

# Запуск анализатора
dotnet run --project src/Nomos.Analyzer.CSharp -- manifest
dotnet run --project src/Nomos.Analyzer.CSharp -- analyze --root tests/fixtures/golden/sample-project --sarif nomos.sarif

# Перегенерировать golden-файлы, затем просмотреть diff
$env:NOMOS_UPDATE_GOLDEN=1; dotnet test tests/Nomos.Analyzer.Tests; Remove-Item Env:NOMOS_UPDATE_GOLDEN
```

`Directory.Build.props` включает `TreatWarningsAsErrors` и генерацию XML-документации для всего, кроме `*.Tests`: каждый публичный член в `src/` обязан иметь XML-комментарий на английском, иначе сборка падает. Предпочитайте `internal` для вспомогательных типов. Версии пакетов — только в `Directory.Packages.props`.

## Устройство

Поток: `ILanguageAdapter` превращает исходники в IR (`ProjectModel`), `AnalysisEngine` выбирает и параллельно запускает `IAnalyzer`, затем применяет подавления и считает `HealthScorer`; `Nomos.Facts` строит facts и SARIF.

- **Детекторы перечислены явно** в `BuiltInComponents` (`Nomos.Analyzer.CSharp`). Новый класс с `[Analyzer]` нужно добавить туда: тест `Catalog_HasEveryClassMarkedAsAnalyzer` проверяет полноту, а `AnalyzerIds_ExistInSpecRules` — наличие id в `spec/rules`.
- **`--config` — файл рабочей области** (`contracts/nomos.schema.json`), его читает `WorkspaceFile`. `NomosConfig` — внутренние настройки движка; `nomos.json` в фикстурах анализаторов остаётся в его формате.
- **Анализаторы видят только IR.** `using Microsoft.CodeAnalysis` допустим лишь в `Nomos.Languages.CSharp`. Логику, нужную нескольким анализаторам, кладите в `src/Nomos.Abstractions/Ir/Queries.cs` или `Flow.cs`.
- **Парадигмы, языки и категории — строки**, не enum. Классы `Paradigms`, `Languages`, `Categories` содержат лишь константы.
- **Анализатор без файла фикстур не пройдёт тесты.** `AnalyzerFixtureTests` строит тесты по каталогу и ожидает `tests/fixtures/<язык>/<первая парадигма или universal>/<Id>/{bad,good}.cs`. Строки в `bad.cs` с `// expect` обязаны получить находку; `nomos.json` рядом задаёт пороги.
- **Активность и включённость парадигмы — разные вещи (D-034).** Активность следует из кода (`ParadigmSigns`, `activeParadigms` в facts), включённость задаёт конфигурация или `DefaultParadigms`. Правило применяется при обоих условиях; `spec/paradigms.md` описывает записи `skippedRules` для каждого случая. Таблицу активации harness читает из этого файла, поэтому формат её строк менять нельзя.
- **Новая метрика — общая функция.** Размеры лежат в `SizeMetrics`, метрики функции — в `CallableMetrics`, типа — в `TypeMetrics`, оценка времени — в `ComplexityEstimates`, blast radius — в `DependencyGraphs.BlastRadii`; facts и анализатор вызывают одну и ту же. Значение для `measured` сначала определяется в `spec/metrics.md`.
- **Любая находка — эвристика.** `AnalysisContext.Report` требует `Confidence` и непустое объяснение. `Report` принимает интерполированную строку; `MessageTemplateTests` читает их из исходников и ищет в spec (D-052).
- **Вывод детерминирован.** Нельзя добавлять в отчёт время, абсолютные пути и порядок из `ConcurrentBag`. Изменение текста находки или версии меняет golden-файлы.

## Подводные камни

- Внутри пространства имён `Nomos.Languages.*` имя `Languages` означает namespace, а внутри `Nomos.Analyzers.Paradigms` так было бы с `Paradigms`. Поэтому код там пишет `Abstractions.Languages.CSharp`, а проект Paradigms имеет namespace `Nomos.Analyzers.Profiles`.
- C#-адаптер делает одну компиляцию на все файлы без NuGet-ссылок (D-003). Символы могут быть не разрешены: `SymbolRef.Id` и `TypeRef.Id` тогда null, и анализатор обязан работать по именам.
- В IR `Id` типов используют метаданные: `System.Int32`, а не `int`.
- Модуль C# — это namespace, он может охватывать несколько файлов и проектов.
- Новый синтаксис Roslyn, не описанный в `BodyConverter`, становится `OpaqueExpression`. Если анализатор что-то не видит, сначала проверьте, что `IrBuilder.cs` переносит эту конструкцию в IR: так были найдены пропуски инициализаторов свойств и `when`-условий.
