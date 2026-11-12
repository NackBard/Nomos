import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { AnalysisRun } from "../core/model";
import { focusDiagram, projectDiagram, toMermaid, toPlantUml } from "../core/uml";
import type { ClassDiagram } from "../core/uml";
import { graphFocus } from "./graphPanel";
import { interfaceTranslator } from "./translate";

export interface DiagramTarget { module: string; peer?: string }

/**
 * Saves the class diagram of a module, of the links between two modules or of a whole analysis, as PlantUML or Mermaid
 * text. Without a target it takes what the graph shows at the types level, otherwise it asks for a module or the project.
 */
export async function exportClassDiagram(runs: AnalysisRun[], target?: DiagramTarget): Promise<void> {
  const t = interfaceTranslator();
  if (!runs.length) {
    void vscode.window.showInformationMessage(t("No data yet: run Nomos: Analyze Workspace."));
    return;
  }
  target ??= graphFocus();
  let found: { diagram: ClassDiagram } | undefined;
  let run: AnalysisRun | undefined;
  let name: string;
  if (target?.module) {
    found = focusDiagram(runs, target.module, target.peer);
    run = runs.find((r) => r.facts.modules.some((m) => m.id === target.module));
    name = [target.module, target.peer].filter(Boolean).join("-");
  } else {
    // Every type of an analysis first, one entry per analysis, then the modules one by one.
    const whole = runs.map((r) => ({ label: `$(project) ${t("Whole project")}`, description: r.language, detail: t("{0} {0|type|types|types}", r.facts.types.length), run: r, module: undefined as string | undefined }));
    const modules = runs.flatMap((r) => r.facts.modules.map((m) => ({ label: m.name, description: r.language, detail: undefined as string | undefined, run: r, module: m.id as string | undefined })));
    const picked = await vscode.window.showQuickPick([...whole, ...modules], { title: t("Nomos: Export Class Diagram"), placeHolder: t("Module whose types to export, or the whole project") });
    if (!picked) return;
    run = picked.run;
    if (picked.module) {
      found = focusDiagram(runs, picked.module);
      name = picked.module;
    } else {
      const project = path.basename(run.root) || run.language;
      found = { diagram: projectDiagram(run.facts, `${project} (${run.language})`) };
      name = `${project}-${run.language}`;
    }
  }
  if (!found || !run) return;
  // A module without types and free functions has nothing to draw: say so instead of saving an empty diagram.
  if (!found.diagram.classes.length) {
    void vscode.window.showInformationMessage(t("{0} has neither types nor functions, so its class diagram is empty.", found.diagram.title));
    return;
  }
  const formats = [
    { label: "PlantUML", description: ".puml", extension: "puml", write: toPlantUml },
    { label: "Mermaid", description: ".mmd", extension: "mmd", write: toMermaid },
  ];
  const format = await vscode.window.showQuickPick(formats, { title: t("Nomos: Export Class Diagram"), placeHolder: t("Format of the diagram") });
  if (!format) return;
  const file = name.replace(/[^A-Za-z0-9._-]+/g, "_");
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(run.root, `${file}.${format.extension}`)),
    filters: { [format.label]: [format.extension] },
    title: t("Nomos: Export Class Diagram"),
  });
  if (!uri) return;
  fs.writeFileSync(uri.fsPath, format.write(found.diagram));
  await vscode.window.showTextDocument(uri, { preview: true });
}
