import assert from "node:assert/strict";
import * as vscode from "vscode";
import type { NomosApi } from "../extension";

/** Runs inside a real VS Code on the folder given by scripts/run-e2e.mjs. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<NomosApi>("nomos.nomos");
  assert.ok(extension, "the extension is not installed in the test host");
  const api = await extension.activate();

  await vscode.commands.executeCommand("nomos.analyze");

  assert.deepEqual(api.errors(), []);
  const [run] = api.runs();
  assert.ok(run, "no analysis run");
  assert.ok(run.findings.length > 0, "no findings");

  const withDiagnostics = vscode.languages.getDiagnostics().filter(([, list]) => list.some((d) => d.source === "nomos"));
  assert.ok(withDiagnostics.length > 0, "no diagnostics were published");

  const entity = run.facts.functions.find((f) => f.location);
  assert.ok(entity?.location);
  const uri = vscode.Uri.joinPath(vscode.Uri.file(run.root), entity.location.file);
  await vscode.workspace.openTextDocument(uri);
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri);
  assert.ok(lenses.some((l) => l.command?.title.includes("cyclomatic")), "no metric lens");

  await vscode.commands.executeCommand("nomos.showGraph");
  await vscode.commands.executeCommand("workbench.view.extension.nomos");

  console.log(`e2e: ${run.findings.length} findings, ${withDiagnostics.length} files with diagnostics, ${lenses.length} lenses in ${entity.location.file}`);
}
