import fs from "node:fs";
import { parseJson } from "./contracts";

/** File in the extension package: spec/practices.yaml as JSON, written by `npm run spec-json` in conformance/runner (D-051). */
export const PracticesFileName = "practices.json";

/** A named set of rules a person may choose to look at; it never hides metrics. */
export interface Practice { id: string; title: string; description: string; rules: string[] }

export function readPractices(file: string): Practice[] {
  const practices = parseJson(fs.readFileSync(file, "utf8"), PracticesFileName);
  if (!Array.isArray(practices)) throw new Error(`${PracticesFileName}: expected an array of practices`);
  return practices as Practice[];
}

/**
 * What to store after a choice: undefined when every practice is chosen, so that practices added in a later version
 * are on as well; otherwise the chosen ids in catalog order.
 */
export function choiceToStore(catalog: Practice[], chosen: string[]): string[] | undefined {
  const set = new Set(chosen);
  if (catalog.every((p) => set.has(p.id))) return undefined;
  return catalog.filter((p) => set.has(p.id)).map((p) => p.id);
}

/** A short line for the status bar tooltip: "all practices", "no practices" or the titles. */
export function describePractices(catalog: Practice[], selected: string[] | undefined): string {
  if (selected === undefined) return "all practices";
  if (!selected.length) return "no practices: no rule runs";
  return selected.map((id) => catalog.find((p) => p.id === id)?.title ?? id).join(", ");
}
