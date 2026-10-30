# Каталог анализаторов

> **Устарело частично (D-020).** Источником правды о правилах теперь служит `spec/rules/*.yaml`. Этот файл описывает текущую реализацию на .NET и будет заменён генерацией из spec на этапе 2. `CC005` в spec называется `CS.NAM001`.

Файл сформирован по атрибутам `[Analyzer]` в исходниках. Описания эвристик приведены на английском, как в коде и отчётах.

Любой результат здесь — эвристика: у каждой находки есть уровень уверенности и объяснение. Метрика может быть точной (число строк, цикломатическая сложность), но вывод «это плохо» остаётся оценкой.

«Парадигма: любая» означает, что анализатор работает при всех профилях.

## Principles

| Id | Название | Серьёзность | Парадигмы | Язык | Эвристика | Пороги и значения по умолчанию |
|---|---|---|---|---|---|---|
| PRN001 | Single Responsibility | Major | oop | любой | A class that takes many constructor dependencies, or reaches into many project modules, likely has several reasons to change. | `maxConstructorDependencies`=5, `maxModules`=4, `minMethods`=3 |
| PRN002 | Open/Closed | Minor | oop | любой | The same enum switched on in several places means adding a value requires editing all of them. | `minOccurrences`=2, `minCases`=3 |
| PRN003 | Liskov Substitution | Major | oop | любой | An override or implementation that only throws NotSupported/NotImplemented cannot stand in for its base type. | — |
| PRN004 | Interface Segregation | Minor | oop | любой | Interfaces with many members, or whose implementers stub some of them, force clients to depend on what they do not use. | `maxMembers`=10 |
| PRN005 | Dependency Inversion | Minor | oop | любой | Creating a project class that implements a project abstraction binds the caller to the concrete type. Test classes (methods with `Fact`, `Theory`, `Test`, `TestMethod`, `TestCase`) are skipped. | `compositionRootSuffixes`=["Factory", "Builder", "Program", "Startup", "Module", "Registry", "Tests"] |
| PRN006 | Don't Repeat Yourself | Minor | любая | любой | Callables whose IR is identical up to local names and literals encode one piece of knowledge twice. | `minNodes`=25 |
| PRN007 | Keep It Simple | Minor | любая | любой | Long boolean conditions and nested ternaries pack too many decisions into one expression. | `maxBooleanOperators`=3 |
| PRN008 | You Aren't Gonna Need It | Minor | любая | любой | Non-public abstractions without enough implementers and unused private parameters are generality nobody uses. | — |
| PRN009 | Law of Demeter | Minor | oop | любой | A chain that walks through several distinct project types couples the caller to their internal structure. | `maxHops`=2 |

## CleanCode

| Id | Название | Серьёзность | Парадигмы | Язык | Эвристика | Пороги и значения по умолчанию |
|---|---|---|---|---|---|---|
| CC001 | Long method | Minor | oop, structural, functional | любой | Counts source lines of a callable against maxLines. | `maxLines`=40 |
| CC002 | Large class | Minor | oop | любой | Counts lines and members of a type, over all partial parts. | `maxLines`=400, `maxMembers`=30 |
| CC003 | Too many parameters | Minor | oop, structural, functional | любой | Counts parameters of a callable; constructors have a separate limit because of dependency injection. | `maxParameters`=5, `maxConstructorParameters`=7 |
| CC004 | Deep nesting | Minor | oop, structural, functional | любой | Measures nesting of branches, loops and guarded blocks; 'else if' chains stay flat. | `maxDepth`=4 |
| CC005 | Naming conventions | Info | oop, structural, functional | C# | Types, methods and properties use PascalCase, interfaces start with I, parameters use camelCase; also flags one-letter parameters of public methods. | — |
| CC006 | Placeholders | Minor | oop, structural, functional | любой | Finds TODO, FIXME, HACK and XXX comments and bodies that only throw NotImplementedException. | — |
| CC007 | Dead code | Minor | oop, structural, functional | любой | Finds unreachable statements, unused locals, and private members nothing in the type refers to. | — |
| CC008 | Commented-out code | Minor | oop, structural, functional | любой | Line comments that end like statements are probably disabled code; version control keeps the history instead. | — |
| CC009 | Empty catch | Major | oop, structural, functional | любой | A catch block with no statements and no comment silently discards the failure. | — |

## Paradigm (ООП, функциональная, структурная)

| Id | Название | Серьёзность | Парадигмы | Язык | Эвристика | Пороги и значения по умолчанию |
|---|---|---|---|---|---|---|
| FUN001 | Impure function | Minor | functional | любой | A callable that returns a value and also writes state or performs I/O cannot be reasoned about by substitution. | — |
| FUN002 | Side effect in lambda | Minor | functional | любой | A lambda passed to a higher-order function that changes outer variables couples the result to evaluation order. | — |
| FUN003 | Mutable state | Minor | functional | любой | Reports reassigned locals, mutable instance fields and settable properties. | — |
| FUN004 | Non-tail recursion | Minor | functional | любой | A self-call whose result is used further cannot be turned into a loop by tail-call elimination. | — |
| FUN005 | Higher-order depth | Minor | functional | любой | Order 1 takes plain data, order 2 takes functions, order 3 takes functions of functions; high orders and nested lambdas are hard to follow. | `maxOrder`=3, `maxLambdaNesting`=3 |
| OOP001 | Encapsulation | Major | oop | любой | Public mutable fields hand a type's invariants to every caller. | — |
| OOP002 | Inheritance depth | Minor | oop | любой | Reports the depth of inheritance tree (DIT) and flags hierarchies deeper than maxDepth. | `maxDepth`=4 |
| OOP003 | Polymorphism | Minor | oop | любой | Several runtime type tests on project types in one callable usually reimplement virtual dispatch. | `minTypeTests`=3 |
| OOP004 | Cohesion | Minor | oop | любой | LCOM4 counts groups of methods that share no state; more than one group suggests a class that could be split. | `maxLcom`=2, `minMethods`=4 |
| OOP005 | Coupling | Minor | oop | любой | Coupling Between Objects counts distinct types a class depends on, ignoring the System namespace. | `maxCoupling`=15 |
| OOP006 | Refused bequest | Minor | oop | любой | A subclass that overrides nothing and touches no inherited member gains nothing from its base class. | — |
| STR001 | Goto | Minor | structural | любой | Goto breaks the single-entry, single-exit structure of blocks. 'goto case' is not flagged. | — |
| STR002 | Global state | Major | structural | любой | Non-private static mutable fields and properties, and module-level variables, act as globals. | — |
| STR003 | Module size | Minor | structural | любой | Measures lines of code per module and lines per file. | `maxModuleLines`=3000, `maxFileLines`=800 |

## Algorithms

| Id | Название | Серьёзность | Парадигмы | Язык | Эвристика | Пороги и значения по умолчанию |
|---|---|---|---|---|---|---|
| ALG001 | Time complexity estimate | Minor | любая | любой | Estimates growth from loop nesting, known linear calls, recursion shape and project callees. Always an estimate: input sizes are unknown. | `reportFromDegree`=2 |
| ALG002 | Quadratic pattern | Minor | любая | любой | Finds list searches, front insertions and string concatenation inside loops. | — |
| ALG003 | Allocation in hot loop | Minor | любая | любой | Finds materializing calls in loops, and object creation or closures in nested loops. | `minDepthForObjects`=2 |
| ALG004 | Space complexity estimate | Minor | любая | любой | Estimates extra memory from collections growing in loops, arrays of non-constant size and recursion depth. | `reportFromDegree`=2 |

## Design

| Id | Название | Серьёзность | Парадигмы | Язык | Эвристика | Пороги и значения по умолчанию |
|---|---|---|---|---|---|---|
| DSN001 | Main sequence distance | Minor | любая | любой | Computes Ca, Ce, instability I, abstractness A and distance D = |A + I - 1| per module. D near 1 means rigid or useless. | `maxDistance`=0.7, `minCoupling`=3 |
| DSN002 | Dependency cycles | Major | любая | любой | Runs Tarjan's algorithm on the module graph and the type graph. | — |
| DSN003 | Layer violations | Major | любая | любой | Maps modules to the layers from configuration and flags dependencies on layers that are not allowed. | — |
| DSN004 | God class | Major | любая | любой | Lanza and Marinescu's detection strategy: high WMC, much foreign data used (ATFD), low cohesion (TCC). | `minWmc`=47, `minAtfd`=5, `maxTcc`=1.0 / 3 |
| DSN005 | Feature envy | Minor | любая | любой | A method that uses more data of one other type than of its own probably belongs there. | `minForeignMembers`=3 |
| DSN006 | Blast radius | Minor | любая | любой | Walks reversed dependencies from each type to count what a change can reach. | `maxDependents`=20 |

## Patterns

| Id | Название | Серьёзность | Парадигмы | Язык | Эвристика | Пороги и значения по умолчанию |
|---|---|---|---|---|---|---|
| PAT001 | Singleton | Info | oop | любой | A class with only private constructors that exposes a static instance of itself. | — |
| PAT002 | Factory | Info | oop | любой | A method that returns an abstraction and creates several of its concrete subtypes. | — |
| PAT003 | Strategy | Info | oop | любой | A context class that receives one of several interchangeable implementations and delegates to it. | — |
| PAT004 | Observer | Info | oop | любой | A type with events it raises, or a list of observers it notifies in a loop, with subscribe methods. | — |
| PAT005 | Decorator | Info | oop | любой | A class that implements an abstraction, wraps an instance of the same abstraction and forwards to it. | — |
| PAT006 | Repository | Info | oop | любой | A type named *Repository, or a collection-like API of get, add and remove methods over one entity. | — |
| PAT007 | Builder | Info | oop | любой | Fluent methods that return the type itself, plus a terminal Build-like method. | — |
| PAT101 | Service Locator | Minor | oop | любой | Resolving dependencies from a container inside business code hides them from the constructor. | `compositionRootSuffixes`=["Program", "Startup", "Factory", "Module", "Registry", "Extensions"] |
| PAT102 | Anemic Domain Model | Minor | oop | любой | A domain-named class with settable data and no behavior, while logic lives in services. | `minProperties`=3, `domainNamespaces`=["Domain", "Model", "Entities"] |
| PAT103 | Middle Man | Minor | oop | любой | A class that does almost nothing but forward to one collaborator, without implementing a shared abstraction. | `minMethods`=3 |

## Maintainability

| Id | Название | Серьёзность | Парадигмы | Язык | Эвристика | Пороги и значения по умолчанию |
|---|---|---|---|---|---|---|
| MNT001 | Cyclomatic complexity | Minor | любая | любой | Counts decision points per callable; reports every value as a metric and flags those above the limit. | `maxComplexity`=10 |
| MNT002 | Maintainability index | Minor | любая | любой | MI = max(0, (171 - 5.2 ln V - 0.23 G - 16.2 ln L) * 100 / 171), from Halstead volume V, cyclomatic complexity G and lines L. | `minIndex`=20 |
| MNT003 | Duplication | Minor | любая | любой | Finds type-2 clones: token sequences equal after normalizing identifiers and literals, with a rolling hash. | `minTokens`=100 |
| MNT004 | Test coverage | Minor | любая | любой | When thresholds.report points to a Cobertura XML or LCOV file, reports line coverage and flags files below minCoverage. | `report`=string.Empty, `minCoverage`=50 |

## Security

| Id | Название | Серьёзность | Парадигмы | Язык | Эвристика | Пороги и значения по умолчанию |
|---|---|---|---|---|---|---|
| SEC001 | Hardcoded secret (heuristic) | Major | любая | любой | Heuristic: string literals assigned to secret-like names, and literals with the shape of known credentials. Not a substitute for a secret scanner. | — |
| SEC002 | Insecure deserialization (heuristic) | Critical | любая | любой | Heuristic: use of formatters that instantiate arbitrary types from their input, or polymorphic type handling. | — |
| SEC003 | SQL concatenation (heuristic) | Major | любая | любой | Heuristic: SQL-looking text concatenated or interpolated with non-constant values. | — |
