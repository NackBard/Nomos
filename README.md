# Nomos

Платформа статического осмотра исходного кода: статистика, зависимости, сложность алгоритмов, парадигмы, паттерны, чистота кода и базовая безопасность.

Поддерживаются C#, Go, TypeScript, JavaScript, Python, Java, Kotlin и Ruby.

Все выводы — эвристики. У каждой находки есть уровень уверенности и объяснение, почему она появилась. Nomos показывает статистику для анализа разработчиком: порогов приёмки, оценок и кодов возврата от числа находок нет.

Прежнее название — DeepCode.Analizer (D-024).

## Состав

Поставка тремя частями (D-056, D-062):

- **Ядро** — расширение VS Code в `extension/`: дерево, граф, диаграмма классов, находки, настройки, русский интерфейс. Языков не знает.
- **Каталог правил** — `rules.json` и `practices.json`, собираются из `spec/`. Едут в составе ядра.
- **Языковые анализаторы** — `analyzers/<язык>/`, каждый на родных инструментах языка. Поставляются отдельными пакетами: `nomos-csharp`, `nomos-go`, `nomos-typescript` (TypeScript и JavaScript), `nomos-python`, `nomos-java`, `nomos-kotlin`, `nomos-ruby`.

Общие `contracts/` (форматы данных), `spec/` (формулы, правила, парадигмы) и `conformance/` (эталонные случаи, которые проходит каждый анализатор) — один закон для всех языков.

Подробности: [Архитектура](docs/ARCHITECTURE.md), [Как добавить язык](docs/EXTENDING.md), [Каталог правил](docs/ANALYZERS.md), [Журнал решений](docs/DECISIONS.md) (сами решения — в [docs/decisions](docs/decisions/)), [Порядок работ](docs/ROADMAP.md).

## Сборка и проверка

Расширение и пакеты собираются из `extension/`:

```powershell
cd extension
npm install
npm test                           # ядро без VS Code
npm run check-boundary             # в ядре нет языко-специфичного кода
npm run package -- --target win32-x64   # dist/: ядро и языковые пакеты
```

Анализатор C# (нужен .NET SDK 10):

```powershell
cd analyzers/csharp
dotnet build Nomos.slnx
dotnet test Nomos.slnx
dotnet run --project src/Nomos.Analyzer.CSharp -- manifest
dotnet run --project src/Nomos.Analyzer.CSharp -- analyze --root tests/fixtures/golden/sample-project --sarif nomos.sarif > facts.json
```

Facts печатаются в stdout, находки пишутся в файл SARIF.

Conformance — все анализаторы на одних и тех же случаях:

```powershell
cd conformance/runner
npm install
npm run all
```

Подробнее о harness и его командах — [conformance/README.md](conformance/README.md).

## Протокол анализатора

```
nomos-<язык> manifest
nomos-<язык> analyze --root <путь> [--sarif <файл>] [--config <nomos.json>] [--rules <id,id>]
```

Коды выхода: 0 — успех, 1 — непредвиденная ошибка, 2 — ошибка использования, 3 — входные данные не годятся, 4 — частичный результат. Число находок и балл на код выхода не влияют.

## Лицензия

MIT. Издатель — honestarchitector.
