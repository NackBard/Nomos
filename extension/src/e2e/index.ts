import assert from "node:assert/strict";
import * as vscode from "vscode";
import type { NomosApi } from "../extension";
import { focusDiagram, toMermaid, toPlantUml } from "../core/uml";
import { openNextToGraph } from "../ui/graphPanel";
import { interfaceTranslator } from "../ui/translate";

/** Runs inside a real VS Code on the folder given by scripts/run-e2e.mjs. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<NomosApi>("honestarchitector.nomos");
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
    // Findings are faint hints by default; the setting changes their look without a new analysis.
    assert.ok(withDiagnostics.every(([, list]) => list.every((d) => d.source !== "nomos" || d.severity === vscode.DiagnosticSeverity.Hint)), "findings must be hints by default");
    const settings = vscode.workspace.getConfiguration("nomos");
    await settings.update("diagnostics", "off", vscode.ConfigurationTarget.Global);
    try {
      const left = vscode.languages.getDiagnostics().filter(([, list]) => list.some((d) => d.source === "nomos"));
      assert.equal(left.length, 0, "diagnostics must be gone when the setting is off");
    } finally {
      await settings.update("diagnostics", undefined, vscode.ConfigurationTarget.Global);
    }
    assert.ok(vscode.languages.getDiagnostics().some(([, list]) => list.some((d) => d.source === "nomos")), "diagnostics must come back");
  } else {
    // Without nomos.json the bundled analyzers run (D-046); a small clean project may have no findings.
    for (const each of runs) assert.ok(each.facts.files.length > 0, `${each.language} analyzed no files`);
    // With language packs installed (npm run e2e -- <folder> --packs) every analyzer that ran comes from its pack (D-062).
    if (process.env.NOMOS_E2E_PACKS) {
      const own = extension.extensionPath;
      const folders = new Map(api.registry().analyzers.map((a) => [a.language, a.folder ?? own]));
      for (const each of runs) assert.ok(!folders.get(each.language)!.startsWith(own), `${each.language} ran from the core's bundle, not from its pack`);
    }
    // Practices chosen in the settings reach the analyzer through the extension's own workspace file (D-050, D-051).
    const settings = vscode.workspace.getConfiguration("nomos", folder);
    await settings.update("practices", ["security"], vscode.ConfigurationTarget.WorkspaceFolder);
    try {
      await vscode.commands.executeCommand("nomos.analyze");
      assert.deepEqual(api.errors(), []);
      for (const each of api.runs()) {
        const skipped = each.facts.skippedRules.find((s) => s.ruleId === "CC003");
        assert.equal(skipped?.reason, "disabled-by-config", `${each.language}: CC003 must be off outside the security practice`);
        assert.ok(each.findings.every((f) => f.ruleId.startsWith("SEC")), `${each.language}: only security rules may report`);
      }
    } finally {
      await settings.update("practices", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    }
    await vscode.commands.executeCommand("nomos.analyze");
  }

  // In Russian every finding with a template of spec reads in Russian; in English the analyzer's text stays (D-052).
  const templated = runs.flatMap((r) => r.findings).filter((f) => f.messageId);
  const cyrillic = (text: string) => /[а-яё]/i.test(text);
  const russian = interfaceTranslator().locale === "ru";
  assert.ok(templated.every((f) => cyrillic(f.message) === russian), `finding texts must be ${russian ? "Russian" : "English"}`);
  const ours = withDiagnostics.flatMap(([, list]) => list.filter((d) => d.source === "nomos"));
  assert.ok(ours.every((d) => cyrillic(d.message) === russian), "diagnostics must follow the language");

  const entity = run.facts.functions.find((f) => f.location);
  assert.ok(entity?.location);
  const uri = vscode.Uri.joinPath(vscode.Uri.file(run.root), entity.location.file);
  await vscode.workspace.openTextDocument(uri);
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri);
  assert.ok(lenses.some((l) => l.command?.title.includes("cyclomatic")), "no metric lens");

  const graphTitle = interfaceTranslator()("Nomos: Dependency Graph");
  await vscode.commands.executeCommand("nomos.showGraph");
  // The tab list catches up with a new panel a moment after the command returns.
  const graphGroup = async (): Promise<vscode.ViewColumn> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const group = vscode.window.tabGroups.all.find((g) => g.tabs.some((t) => t.label === graphTitle));
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
  const graphTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.label === graphTitle);
  assert.equal(graphTabs.length, 1, "the graph must stay a single tab");

  // Stage 11: every analyzer fills the structure of facts 1.3.0, and the class diagram of its largest module with types
  // has members. A language written only with functions in this folder has no class diagram to check.
  assert.ok((await vscode.commands.getCommands(true)).includes("nomos.exportClassDiagram"), "no export command");
  for (const each of runs) {
    const withTypes = each.facts.modules.filter((m) => each.facts.types.some((t) => t.module === m.id));
    const largest = [...withTypes].sort((a, b) => b.loc - a.loc)[0];
    if (!largest) continue;
    const diagram = focusDiagram(runs, largest.id)?.diagram;
    assert.ok(diagram?.classes.some((c) => c.attributes.length + c.operations.length > 0), `${each.language}: no members in the class diagram of ${largest.id}`);
    if (!diagram) return;
    assert.match(toPlantUml(diagram), /^@startuml\n[\s\S]*@enduml\n$/);
    assert.match(toMermaid(diagram), /\nclassDiagram\n/);
  }

  console.log(`e2e ${vscode.env.language} (${configured ? "nomos.json" : "bundled analyzers"}): ${runs.map((r) => `${r.language} ${r.findings.length}`).join(", ")} findings, ${withDiagnostics.length} files with diagnostics, ${lenses.length} lenses in ${entity.location.file}`);
}
