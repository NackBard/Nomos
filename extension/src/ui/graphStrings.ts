import type { Translate } from "../core/l10n";

/**
 * Every text of the graph page, as templates of the interface language (D-052): graph.js holds no words of its own and
 * fills {n} and {n|one|few|many} itself. Without the VS Code API, so that screenshots can render it in any locale.
 */
export function graphStrings(t: Translate) {
  return {
    modules: t.template("Modules"),
    types: t.template("Types"),
    kinds: {
      inheritance: { name: t.template("inheritance"), out: t.template("inherits"), in: t.template("inherited by") },
      call: { name: t.template("call"), out: t.template("calls"), in: t.template("called by") },
      "type-ref": { name: t.template("type use"), out: t.template("uses type"), in: t.template("type used by") },
      import: { name: t.template("import"), out: t.template("imports"), in: t.template("imported by") },
      // Relations of the class diagram (spec/structure.md).
      "uml-generalization": { name: t.template("generalization"), out: t.template("extends"), in: t.template("extended by") },
      "uml-realization": { name: t.template("realization"), out: t.template("implements"), in: t.template("implemented by") },
      "uml-association": { name: t.template("association"), out: t.template("holds"), in: t.template("held by") },
      "uml-embed": { name: t.template("embedding"), out: t.template("embeds"), in: t.template("embedded in") },
      "uml-dependency": { name: t.template("dependency"), out: t.template("depends on"), in: t.template("needed by") },
    } as Record<string, { name: string; out: string; in: string }>,
    otherFrom: t.template("{0} (from)"),
    noLinks: t.template("no links shown"),
    depth: t.template("Depth:"),
    cycle: t.template("cycle"),
    toggleKind: t.template("Show or hide \"{0}\" links"),
    moduleHint: t.template("Click a module to see its types, a line to see the types it joins"),
    summary: t.template("{0}: {1} nodes, {2} edges, {3} in cycles"),
    noTypeLinks: t.template("{0}: no links between types"),
    noData: t.template("No data yet: run Nomos: Analyze Workspace."),
    pointHint: t.template("Point at a node to list its links; the fins on a line point to what is inherited, called or used."),
    openPair: t.template("Click to see the types it joins"),
    umlPointHint: t.template("Point at a class to list its relations; the end of a line shows its kind: a triangle for a general type, a diamond for an embedded one, an arrow for a field or a use."),
    uml: t.template("UML"),
    umlHint: t.template("Show the types as UML classes with fields, methods and UML relations"),
    exportDiagram: t.template("Export…"),
    exportHint: t.template("Save this class diagram as PlantUML or Mermaid text"),
  };
}

export type GraphStrings = ReturnType<typeof graphStrings>;
