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
  const runs = api.runs();
  const [run] = runs;
  assert.ok(run, "no analysis run");
  const folder = vscode.workspace.workspaceFolders![0].uri;
  const workspace = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, "nomos.json"))).toString("utf8")) as { analyzers: { language: string }[] };
  assert.deepEqual(runs.map((r) => r.language).sort(), workspace.analyzers.map((a) => a.language).sort(), "every analyzer of nomos.json must run");
  for (const each of runs) assert.ok(each.findings.length > 0, `no findings from ${each.language}`);

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
  await vscode.commands.executeCommand("nomos.openGraphWindow");
  const graphTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.label === "Nomos: Dependency Graph");
  assert.equal(graphTabs.length, 1, "the graph must stay a single tab");

  console.log(`e2e: ${runs.map((r) => `${r.language} ${r.findings.length}`).join(", ")} findings, ${withDiagnostics.length} files with diagnostics, ${lenses.length} lenses in ${entity.location.file}`);
}
