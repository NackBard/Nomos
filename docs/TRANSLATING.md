# Translating Nomos

Nomos speaks English and Russian. A new language is added in this repository, by a pull request, and ships with the next release of the packages; there are no separate translation packs (D-067).

## What is translated where

| Text | English source | Translation |
|---|---|---|
| Strings of the Nomos extension (messages, tree, graph page) | calls of `t("…")` in `extension/src` | `extension/l10n/bundle.l10n.<lang>.json` |
| Menus, commands, settings of the extension | `extension/package.nls.json` | `extension/package.nls.<lang>.json` |
| Nomos Score | `score/src`, `score/package.nls.json` | `score/l10n/bundle.l10n.<lang>.json`, `score/package.nls.<lang>.json` |
| Nomos Agents | `agents/src`, `agents/package.nls.json` | `agents/l10n/bundle.l10n.<lang>.json`, `agents/package.nls.<lang>.json` |
| Reports of the `ci` command | `ci/src` | `ci/l10n/bundle.l10n.<lang>.json` |
| Rules, practices, texts of findings | `spec/rules/*.yaml`, `spec/practices.yaml` | for now only `l10n.ru` and `messages.<key>.ru`, see below |

`<lang>` is the language code VS Code uses: `de`, `fr`, `ar`, `zh-cn`, `pt-br`. A bundle maps the English string to its translation; a missing string is shown in English.

## Steps

1. Fork the repository and create a branch, e.g. `l10n-ar`.
2. Copy each Russian file to your language and translate the values, never the keys: `bundle.l10n.ru.json` → `bundle.l10n.ar.json`, `package.nls.ru.json` → `package.nls.ar.json`. The English source of a bundle entry is its key; of `package.nls.<lang>.json`, the same key in `package.nls.json`.
3. Keep the placeholders: `{0}`, `{1}` are arguments and must all stay, none added. `{{` and `}}` are braces. `{0|one|few|many}` picks a word form by the number `{0}` — see the limits below.
4. Check:
   ```
   cd extension
   npm install
   npm run check-l10n
   ```
   A broken placeholder or a key nobody uses fails (`FAIL`). A string you have not translated yet only warns (`WARN`), so a partial translation can be sent too.
5. Look at it: `code --locale ar` starts VS Code in your language; install the packages from `dist/` (`npm run package` in `extension`, `score`, `agents`) or run `npm run e2e` in `extension`.
6. Open a pull request against `main`. Say which parts are translated and what you looked at.

## Limits today

The interface follows the language of VS Code. The core of Nomos, however, knows only English and Russian: `extension/src/core/l10n.ts` maps every other language to English, word forms `{n|…|…|…}` follow Russian rules (three forms), and rules in `spec` carry only `ru`. So the bundles and `package.nls` of a new language are picked up by VS Code at once, while texts of findings and rules stay English until the core learns the language. Making the core general — any language code, plural forms by `Intl.PluralRules`, `l10n.<lang>` in spec — is planned before the first translation is merged (`docs/ROADMAP.md`). Right-to-left languages also need the graph and Score pages checked.

Good to know:

- Names of metrics (`cyclomatic`, `CBO`), ids of rules and practices, and code are not translated.
- Keep it short: texts appear in narrow trees and tooltips.
- A changed English string is a new key. `check-l10n` then reports the old one as unused in every language; translate the new one.
