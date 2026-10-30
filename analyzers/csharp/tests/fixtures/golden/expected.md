# Nomos report: sample-project

**Health: 85.3** | 3 files | 16 findings | 2 suppressed

- Mean of 3 module score(s), weighted by lines of code (58 total).
- Lowest: Sample.Domain = 82.6 (8 lines).
- Lowest: Sample.Services = 84.6 (45 lines).
- Lowest: Sample.Legacy = 96.2 (5 lines).

Every finding is a heuristic result. Confidence states how likely it is to be right.

## Categories

| Category | Score | Weight | Findings |
|---|---:|---:|---:|
| Algorithms | 79.9 | 0.121 | 2 |
| CleanCode | 80.2 | 0.121 | 7 |
| Design | 89.3 | 0.152 | 2 |
| Maintainability | 100.0 | 0.152 | 0 |
| Paradigm | 81.9 | 0.091 | 2 |
| Patterns | 98.1 | 0.061 | 1 |
| Principles | 89.2 | 0.121 | 1 |
| Security | 71.9 | 0.182 | 1 |

## Modules

| Module | Score | Lines |
|---|---:|---:|
| Sample.Domain | 82.6 | 8 |
| Sample.Services | 84.6 | 45 |
| Sample.Legacy | 96.2 | 5 |

## Findings

### Major (4)

- **DSN002** `Domain/Order.cs:5` (High confidence): Module cycle: Sample.Domain <-> Sample.Services
  - These modules depend on each other, directly or transitively, so none can be built, tested or released alone.
- **DSN003** `Domain/Order.cs:10` (High confidence): Domain must not depend on Services
  - Order (Sample.Domain) uses Notifier (Sample.Services); allowed: none.
- **OOP001** `Domain/Order.cs:10` (High confidence): Public mutable field Order.Listener
  - Any caller can change this field, so the type cannot protect its invariants. A property or a method can.
- **SEC001** `Services/OrderService.cs:14` (Medium confidence): ApiKey looks like a hardcoded secret
  - Heuristic: the name suggests a secret and the value is a literal. It may be a placeholder or a non-secret value.

### Minor (12)

- **CC006** `Services/OrderService.cs:45` (High confidence): TODO comment left in code
  - A placeholder records unfinished work that belongs in the issue tracker or in a fix.
- **PAT102** `Domain/Order.cs:5` (Medium confidence): Order is an anemic domain object
  - 3 public setters and no methods: its invariants must be enforced by whoever changes it. Plain DTOs are fine; this one sits in a domain namespace.
- **OOP004** `Services/OrderService.cs:12` (Medium confidence): OrderService splits into 4 unrelated method groups
  - LCOM4 finds method groups that share no field and do not call each other; each may be a separate class.
- **ALG001** `Services/OrderService.cs:26` (Medium confidence): Matches is likely O(n²)
  - Estimated from nested loops over inputs of unknown size. Small inputs may make this irrelevant.
- **ALG001** `Services/OrderService.cs:36` (Medium confidence): Pairs is likely O(n²)
  - Estimated from nested loops over inputs of unknown size. Small inputs may make this irrelevant.
- **PRN005** `Services/OrderService.cs:48` (Medium confidence): OrderService creates Notifier directly
  - Notifier is available through INotifier, but Pay instantiates the concrete class. Injecting the abstraction keeps OrderService replaceable and testable.
- **CC005** `Legacy/Old.cs:6` (Low confidence): Parameter a of Many says little
  - One-letter names in a public signature leave the meaning to the reader.
- **CC005** `Legacy/Old.cs:6` (Low confidence): Parameter b of Many says little
  - One-letter names in a public signature leave the meaning to the reader.
- **CC005** `Legacy/Old.cs:6` (Low confidence): Parameter c of Many says little
  - One-letter names in a public signature leave the meaning to the reader.
- **CC005** `Legacy/Old.cs:6` (Low confidence): Parameter d of Many says little
  - One-letter names in a public signature leave the meaning to the reader.
- **CC005** `Legacy/Old.cs:6` (Low confidence): Parameter e of Many says little
  - One-letter names in a public signature leave the meaning to the reader.
- **CC005** `Legacy/Old.cs:6` (Low confidence): Parameter f of Many says little
  - One-letter names in a public signature leave the meaning to the reader.
