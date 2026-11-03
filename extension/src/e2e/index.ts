import assert from "node:assert/strict";
import * as vscode from "vscode";
import type { NomosApi } from "../extension";
import { openNextToGraph } from "../ui/graphPanel";

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
  const workspaceFile = vscode.Uri.joinPath(folder, "nomos.json");
  const configured = await vscode.workspace.fs.stat(workspaceFile).then(() => true, () => false);
  const withDiagnostics = vscode.languages.getDiagnostics().filter(([, list]) => list.some((d) => d.source === "nomos"));
  if (configured) {
    const workspace = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(workspaceFile)).toString("utf8")) as { analyzers: { language: string }[] };
    assert.deepEqual(runs.map((r) => r.language).sort(), workspace.analyzers.map((a) => a.language).sort(), "every analyzer of nomos.json must run");
    for (const each of runs) assert.ok(each.findings.length > 0, `no findings from ${each.language}`);
    assert.ok(withDiagnostics.length > 0, "no diagnostics were published");
  } else {
    // Without nomos.json the bundled analyzers run (D-046); a small clean project may have no findings.
    for (const each of runs) assert.ok(each.facts.files.length > 0, `${each.language} analyzed no files`);
  }

  const entity = run.facts.functions.find((f) => f.location);
  assert.ok(entity?.location);
  const uri = vscode.Uri.joinPath(vscode.Uri.file(run.root), entity.location.file);
  await vscode.workspace.openTextDocument(uri);
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri);
  assert.ok(lenses.some((l) => l.command?.title.includes("cyclomatic")), "no metric lens");

  await vscode.commands.executeCommand("nomos.showGraph");
  // The tab list catches up with a new panel a moment after the command returns.
  const graphGroup = async (): Promise<vscode.ViewColumn> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const group = vscode.window.tabGroups.all.find((g) => g.tabs.some((t) => t.label === "Nomos: Dependency Graph"));
      if (group) return group.viewColumn;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("the graph tab did not appear");
  };
  await openNextToGraph(uri, 0, await graphGroup());
  const groups = vscode.window.tabGroups.all.length;
  const shown = await openNextToGraph(uri, 5, await graphGroup());
  assert.equal(Math.abs(shown.viewColumn! - await graphGroup()), 1, "code must open in the group next to the graph");
  assert.equal(vscode.window.tabGroups.all.length, groups, "a split screen must not get another group");
  await vscode.commands.executeCommand("workbench.view.extension.nomos");
  await vscode.commands.executeCommand("nomos.openGraphWindow");
  const fromWindow = await openNextToGraph(uri, 5, await graphGroup());
  assert.equal(Math.abs(fromWindow.viewColumn! - await graphGroup()), 1, "code must open next to the graph in a separate window too");
  const graphTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.label === "Nomos: Dependency Graph");
  assert.equal(graphTabs.length, 1, "the graph must stay a single tab");

  console.log(`e2e (${configured ? "nomos.json" : "bundled analyzers"}): ${runs.map((r) => `${r.language} ${r.findings.length}`).join(", ")} findings, ${withDiagnostics.length} files with diagnostics, ${lenses.length} lenses in ${entity.location.file}`);
}
