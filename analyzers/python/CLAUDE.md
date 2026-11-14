# Анализатор Python

`python -I main.py manifest | analyze --root …`; локально интерпретатор — `py` (Python 3.14), в CI — 3.10, минимальная поддерживаемая. Тесты: `py -I -m unittest discover -s tests`. Решения — D-057.

Только стандартная библиотека: `ast` и `tokenize`, код проекта не импортируется. Читает `nomos_python/rules.json` и `practices.json` из `npm run spec-json` (сгенерированы); тексты находок — `tx("шаблон spec", …)`, их проверяет `tests/test_text.py`. Модуль — файл, id через точки; аннотации и `TYPE_CHECKING` — `type-only`; типов без аннотаций нет, `semantic: false`. Код должен разбираться Python 3.10: без `match` в своём коде не обязательно, но без синтаксиса 3.11+ (`except*`, `class C[T]`, `type X = …`).

`run.mjs` находит интерпретатор для harness и `nomos.json`; расширение берёт его из записи `runtime` реестра (`extension/scripts/package.mjs`). Все случаи — `npm run python` в `conformance/runner`. На Windows Python пишет файлы с CRLF: в скриптах `open(..., newline="\n")`.
