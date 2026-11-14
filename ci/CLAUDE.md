# Запуск без IDE

```powershell
npm install
npm test
node src/cli.ts --workspace ../nomos.json --out ../.nomos [--locale ru]
```

Код возврата не зависит от находок (D-021). Отчёты строятся только из facts и SARIF. Строки — через `t("…")`, их проверяет `npm run check-l10n` в `extension`.
