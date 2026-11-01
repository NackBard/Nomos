# Каталог правил

Файл сформирован из `spec/rules/*.yaml` командой `npm run rules-doc` (`conformance/runner`). Правки вносятся в spec; `npm run validate` проверяет, что файл не устарел.

Любой результат — эвристика с уровнем уверенности и объяснением. Порог — чувствительность детектора, а не граница приёмки. Какие правила реализует анализатор, сообщает его `manifest`.

Пустые парадигмы означают, что правило применимо к любому модулю.

## Algorithms

| Id | Название | Серьёзность | Парадигмы | Что смотрит | Порог по умолчанию |
|---|---|---|---|---|---|
| ALG001 | Time complexity estimate | minor | — | Estimates growth from loop nesting, known linear calls, recursion shape and project callees. | `reportFromDegree`=2 |
| ALG002 | Quadratic pattern | minor | — | List searches, front insertions and string concatenation inside loops. | — |
| ALG003 | Allocation in hot loop | minor | — | Materializing calls in loops; object creation or closures in nested loops. | `minDepthForObjects`=2 |
| ALG004 | Space complexity estimate | minor | — | Collections growing in loops, arrays of non-constant size, recursion depth. | `reportFromDegree`=2 |

## CleanCode

| Id | Название | Серьёзность | Парадигмы | Что смотрит | Порог по умолчанию |
|---|---|---|---|---|---|
| CC001 | Long method | minor | oop, structural, functional | Source lines of a callable. | `maxLines`=40 |
| CC002 | Large class | minor | oop | Lines and members of a type, over all of its parts. | `maxLines`=400, `maxMembers`=30 |
| CC003 | Too many parameters | minor | oop, structural, functional | Parameter count of a callable; constructors have a separate limit because of dependency injection. | `maxParameters`=5, `maxConstructorParameters`=7 |
| CC004 | Deep nesting | minor | oop, structural, functional | Nesting depth of branches, loops and guarded blocks; else-if chains stay flat. | `maxDepth`=4 |
| CC006 | Placeholders | minor | oop, structural, functional | TODO, FIXME, HACK and XXX comments, and bodies that only throw not-implemented. | — |
| CC007 | Dead code | minor | oop, structural, functional | Unreachable statements, unused locals, private members nothing refers to. | — |
| CC008 | Commented-out code | minor | oop, structural, functional | Line comments that end like statements. | — |
| CC009 | Empty catch | major | oop, structural, functional | A catch block with no statements and no comment. | — |
| CS.NAM001 | Naming conventions | info | oop, structural, functional | Types, methods and properties in PascalCase, interfaces start with I, parameters in camelCase; one-letter parameters of public methods. | — |

## Design

| Id | Название | Серьёзность | Парадигмы | Что смотрит | Порог по умолчанию |
|---|---|---|---|---|---|
| DSN001 | Main sequence distance | minor | — | Per module Ca, Ce, instability I, abstractness A and distance D (spec/metrics.md). | `maxDistance`=0.7, `minCoupling`=3 |
| DSN002 | Dependency cycles | major | — | Strongly connected components (Tarjan) in the module graph and the type graph. | — |
| DSN003 | Layer violations | major | — | Dependencies on layers that the configuration does not allow. | — |
| DSN004 | God class | major | oop | Lanza and Marinescu detection strategy, high WMC, high ATFD, low TCC. | `minWmc`=47, `minAtfd`=5, `maxTcc`=0.3333 |
| DSN005 | Feature envy | minor | oop | A method using more data of one other type than of its own. | `minForeignMembers`=3 |
| DSN006 | Blast radius | minor | — | Number of types reachable through reversed dependencies (spec/metrics.md). | `maxDependents`=20 |

## Maintainability

| Id | Название | Серьёзность | Парадигмы | Что смотрит | Порог по умолчанию |
|---|---|---|---|---|---|
| MNT001 | Cyclomatic complexity | minor | — | Decision points per callable (spec/metrics.md). Every value is a metric in facts; results are emitted above the limit. | `maxComplexity`=10 |
| MNT002 | Maintainability index | minor | — | MI from Halstead volume, cyclomatic complexity and lines (spec/metrics.md). | `minIndex`=20 |
| MNT003 | Duplication | minor | — | Type-1 and type-2 token clones (rolling hash over normalized tokens). | `minTokens`=100 |
| MNT004 | Test coverage | minor | — | Line coverage from a Cobertura or LCOV report, per file. | `report`="", `minCoverage`=50 |

## Paradigm

| Id | Название | Серьёзность | Парадигмы | Что смотрит | Порог по умолчанию |
|---|---|---|---|---|---|
| FUN001 | Impure function | minor | functional | A callable that returns a value and also writes state or performs I/O. | — |
| FUN002 | Side effect in lambda | minor | functional | A lambda passed to a higher-order function that changes outer variables. | — |
| FUN003 | Mutable state | minor | functional | Reassigned locals, mutable instance fields, settable properties. | — |
| FUN004 | Non-tail recursion | minor | functional | A self-call whose result is used further. | — |
| FUN005 | Higher-order depth | minor | functional | Order of functions (data, functions, functions of functions) and lambda nesting. | `maxOrder`=3, `maxLambdaNesting`=3 |
| OOP001 | Encapsulation | major | oop | Public mutable fields. | — |
| OOP002 | Inheritance depth | minor | oop | Depth of inheritance tree (DIT). | `maxDepth`=4 |
| OOP003 | Polymorphism | minor | oop | Several runtime type tests on project types in one callable. | `minTypeTests`=3 |
| OOP004 | Cohesion | minor | oop | LCOM4, groups of methods that share no state. | `maxLcom`=2, `minMethods`=4 |
| OOP005 | Coupling | minor | oop | Coupling between objects (CBO), excluding the standard library. | `maxCoupling`=15 |
| OOP006 | Refused bequest | minor | oop | A subclass that overrides nothing and touches no inherited member. | — |
| STR001 | Goto | minor | structural | Uses of goto. Switch-case jumps are not flagged. | — |
| STR002 | Global state | major | structural | Non-private static mutable fields and properties, module-level variables. | — |
| STR003 | Module size | minor | structural | Lines of code per module and per file. | `maxModuleLines`=3000, `maxFileLines`=800 |

## Patterns

| Id | Название | Серьёзность | Парадигмы | Что смотрит | Порог по умолчанию |
|---|---|---|---|---|---|
| PAT001 | Singleton | info | oop | A class with only private constructors that exposes a static instance of itself. | — |
| PAT002 | Factory | info | oop | A method that returns an abstraction and creates several of its concrete subtypes. | — |
| PAT003 | Strategy | info | oop | A context class that receives one of several interchangeable implementations and delegates to it. | — |
| PAT004 | Observer | info | oop | A type with events it raises, or a list of observers it notifies in a loop, with subscribe methods. | — |
| PAT005 | Decorator | info | oop | A class that implements an abstraction, wraps an instance of the same abstraction and forwards to it. | — |
| PAT006 | Repository | info | oop | A type named *Repository, or a collection-like API of get, add and remove over one entity. | — |
| PAT007 | Builder | info | oop | Fluent methods that return the type itself plus a terminal Build-like method. | — |
| PAT101 | Service Locator | minor | oop | Resolving dependencies from a container inside business code. | `compositionRootSuffixes`=["Program","Startup","Factory","Module","Registry","Extensions"] |
| PAT102 | Anemic Domain Model | minor | oop | A domain-named class with settable data and no behavior, while logic lives in services. | `minProperties`=3, `domainNamespaces`=["Domain","Model","Entities"] |
| PAT103 | Middle Man | minor | oop | A class that does almost nothing but forward to one collaborator, without a shared abstraction. | `minMethods`=3 |

## Principles

| Id | Название | Серьёзность | Парадигмы | Что смотрит | Порог по умолчанию |
|---|---|---|---|---|---|
| PRN001 | Single Responsibility | major | oop | Counts constructor dependencies of a class and the project modules it reaches into. | `maxConstructorDependencies`=5, `maxModules`=4, `minMethods`=3 |
| PRN002 | Open/Closed | minor | oop | Finds the same enum or tag switched on in several places. | `minOccurrences`=2, `minCases`=3 |
| PRN003 | Liskov Substitution | major | oop | An override or implementation whose body only throws not-supported or not-implemented. | — |
| PRN004 | Interface Segregation | minor | oop | Interfaces with many members, or whose implementers stub some of them. | `maxMembers`=10 |
| PRN005 | Dependency Inversion | minor | oop | Creating a project class that implements a project abstraction, outside composition roots and test classes (a class with test-framework attributes such as Fact, Theory, Test, TestMethod, TestCase). | `compositionRootSuffixes`=["Factory","Builder","Program","Startup","Module","Registry","Tests"] |
| PRN006 | Do not repeat yourself | minor | — | Callables whose structure is identical up to local names and literals. | `minNodes`=25 |
| PRN007 | Keep it simple | minor | — | Long boolean conditions and nested ternaries. | `maxBooleanOperators`=3 |
| PRN008 | You are not going to need it | minor | — | Non-public abstractions with too few implementers, and unused private parameters. | — |
| PRN009 | Law of Demeter | minor | oop | Call chains that walk through several distinct project types. | `maxHops`=2 |

## Security

| Id | Название | Серьёзность | Парадигмы | Что смотрит | Порог по умолчанию |
|---|---|---|---|---|---|
| SEC001 | Hardcoded secret (heuristic) | major | — | String literals assigned to secret-like names, and literals shaped like known credentials. | — |
| SEC002 | Insecure deserialization (heuristic) | critical | — | Use of formatters that instantiate arbitrary types from input, or polymorphic type handling. | — |
| SEC003 | SQL concatenation (heuristic) | major | — | SQL-looking text concatenated or interpolated with non-constant values. | — |
