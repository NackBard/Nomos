import * as vscode from "vscode";
import { interfaceTranslator } from "./translate";

/** Where a setting is written: where it is already set for this workspace, otherwise for the user. */
function targetOf(key: string): vscode.ConfigurationTarget {
  const seen = vscode.workspace.getConfiguration("nomos").inspect(key);
  if (seen?.workspaceFolderValue !== undefined) return vscode.ConfigurationTarget.WorkspaceFolder;
  if (seen?.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
  return vscode.ConfigurationTarget.Global;
}

async function update(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration("nomos").update(key, value, targetOf(key));
}

/**
 * A short menu of the settings a person changes most (metrics above the code, how findings look, analysis on save),
 * with the practices and the full settings one step away. It stays open until Escape, so several can be changed.
 */
export async function showSettingsMenu(extensionId: string): Promise<void> {
  const t = interfaceTranslator();
  const looks: Record<string, { label: string; detail: string }> = {
    hint: { label: t("Faint hints"), detail: t("Dots under the code; not in the Problems panel.") },
    information: { label: t("Underlined"), detail: t("Blue underlines, listed in the Problems panel.") },
    level: { label: t("By the rule's level"), detail: t("Yellow warnings and red errors as the rule says, in the Problems panel.") },
    off: { label: t("Hidden in the editor"), detail: t("Only in the Findings view.") },
  };
  const on = t("on"), off = t("off");
  for (;;) {
    const settings = vscode.workspace.getConfiguration("nomos");
    const lens = settings.get<boolean>("codeLens", true);
    const look = settings.get<string>("diagnostics", "hint");
    const onSave = settings.get<boolean>("analyzeOnSave", false);
    const items: (vscode.QuickPickItem & { id: string })[] = [
      { id: "codeLens", label: `$(symbol-numeric) ${t("Metrics above the code")}`, description: lens ? on : off, detail: t("CodeLens above functions and types.") },
      { id: "diagnostics", label: `$(eye) ${t("Findings in the editor")}`, description: (looks[look] ?? looks.hint).label, detail: t("The Findings view lists them in every case.") },
      { id: "analyzeOnSave", label: `$(save) ${t("Analyze after saving")}`, description: onSave ? on : off, detail: t("Runs the analysis again after a file is saved.") },
      { id: "practices", label: `$(checklist) ${t("Practices…")}`, detail: t("Which rules run; metrics are shown either way.") },
      { id: "all", label: `$(settings-gear) ${t("All Nomos settings…")}` },
    ];
    const picked = await vscode.window.showQuickPick(items, { title: t("Nomos: Settings"), placeHolder: t("Choose a setting to change") });
    if (!picked) return;
    if (picked.id === "codeLens") await update("codeLens", !lens);
    else if (picked.id === "analyzeOnSave") await update("analyzeOnSave", !onSave);
    else if (picked.id === "diagnostics") {
      const choice = await vscode.window.showQuickPick(
        Object.entries(looks).map(([id, l]) => ({ id, label: l.label, detail: l.detail, description: id === look ? t("current") : undefined })),
        { title: t("Findings in the editor") });
      if (choice && choice.id !== look) await update("diagnostics", choice.id);
    } else if (picked.id === "practices") {
      await vscode.commands.executeCommand("nomos.choosePractices");
      return;
    } else {
      await vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${extensionId}`);
      return;
    }
  }
}
