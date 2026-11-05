import * as vscode from "vscode";
import { localeOf, translator } from "../core/l10n";
import type { Translate } from "../core/l10n";

let current: Translate | undefined;

/**
 * Strings of the interface in the language of VS Code (D-052): vscode.l10n loads l10n/bundle.l10n.<language>.json,
 * and the templates are filled by core/l10n, which also knows Russian word forms.
 */
export function interfaceTranslator(): Translate {
  return (current ??= translator(vscode.l10n.bundle, localeOf(vscode.env.language)));
}
