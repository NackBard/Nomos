import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { AnalysisRun } from "../core/model";
import { focusDiagram, toMermaid, toPlantUml } from "../core/uml";
import { graphFocus } from "./graphPanel";
import { interfaceTranslator } from "./translate";

export interface DiagramTarget { module: string; peer?: string }

/**
 * Saves the class diagram of a module, or of the links between two modules, as PlantUML or Mermaid text. Without a
 * target it takes what the graph shows at the types level, otherwise it asks for a module.
 */
export async function exportClassDiagram(runs: AnalysisRun[], target?: DiagramTarget): Promise<void> {
  const t = interfaceTranslator();
  if (!runs.length) {
    void vscode.window.showInformationMessage(t("No data yet: run Nomos: Analyze Workspace."));
    return;
  }
  target ??= graphFocus();
  if (!target?.module) {
    const items = runs.flatMap((r) => r.facts.modules.map((m) => ({ label: m.name, description: r.language, module: m.id })));
    const picked = await vscode.window.showQuickPick(items, { title: t("Nomos: Export Class Diagram"), placeHolder: t("Module whose types to export") });
    if (!picked) return;
    target = { module: picked.module };
  }
  const found = focusDiagram(runs, target.module, target.peer);
  const run = runs.find((r) => r.facts.modules.some((m) => m.id === target.module));
  if (!found || !run) return;
  const formats = [
    { label: "PlantUML", description: ".puml", extension: "puml", write: toPlantUml },
    { label: "Mermaid", description: ".mmd", extension: "mmd", write: toMermaid },
  ];
  const format = await vscode.window.showQuickPick(formats, { title: t("Nomos: Export Class Diagram"), placeHolder: t("Format of the diagram") });
  if (!format) return;
  const name = [target.module, target.peer].filter(Boolean).join("-").replace(/[^A-Za-z0-9._-]+/g, "_");
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(run.root, `${name}.${format.extension}`)),
    filters: { [format.label]: [format.extension] },
    title: t("Nomos: Export Class Diagram"),
  });
  if (!uri) return;
  fs.writeFileSync(uri.fsPath, format.write(found.diagram));
  await vscode.window.showTextDocument(uri, { preview: true });
}
