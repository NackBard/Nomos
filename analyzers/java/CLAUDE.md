# Анализатор Java

`node run.mjs manifest | analyze --root …` — собирает классы в `build/` (когда исходники новее) и запускает на JDK 17+ с `jdk.compiler`: `NOMOS_JAVA`, `JAVA_HOME`, `java` из `PATH`. Тесты: `node run.mjs --test` (`test/nomos/java/Tests.java`, свой каркас без зависимостей). Jar для расширения: `node run.mjs --jar <файл>`. Решения — D-058.

Только стандартная библиотека и `jdk.compiler`: javac Tree API (`com.sun.source`) и `javax.lang.model`, без `com.sun.tools.javac` (иначе нужен `--add-exports`). Код компилируется с `--release 17 -Xlint:all -Werror`: синтаксис новее 17 и API новее 17 в своём коде нельзя, новые деревья javac (метки `case` Java 21) — через отражение, как `Metrics.caseLabels`. JSON — свой `Json.java`, лексер — свой `Lexer.java`. Тексты правил и практики — `src/nomos/java/rules.json` и `practices.json` из `npm run spec-json` (сгенерированы, ресурсы jar); тексты находок — `tx("шаблон spec", …)`, их проверяет тест `templatesAreInSpec`.

Одна компиляция без classpath с `-XDshould-stop.ifError=FLOW`: без опции javac бросает атрибуцию после первой ошибки. Неразрешённые типы — `TypeKind.ERROR`, имя берётся из `import` (`Graph.imported`). Файлы с javac сопоставляются по URI (javac оборачивает `JavaFileObject`). Модуль — пакет, `(global)` без `package`. Все рёбра `runtime`. Все случаи — `npm run java` в `conformance/runner`.
