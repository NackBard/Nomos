import fs from "node:fs";
import { parseJson } from "./contracts";
import { english } from "./l10n";
import type { Translate } from "./l10n";

/** File in the extension package: spec/practices.yaml as JSON, written by `npm run spec-json` in conformance/runner (D-051). */
export const PracticesFileName = "practices.json";

/** A named set of rules a person may choose to look at; it never hides metrics. */
export interface Practice { id: string; title: string; description: string; rules: string[]; l10n?: Record<string, { title: string; description: string }> }

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

/** Title and description of a practice in the interface language (spec/practices.yaml, l10n). */
export function practiceText(practice: Practice, t: Translate = english): { title: string; description: string } {
  return practice.l10n?.[t.locale] ?? { title: practice.title, description: practice.description };
}

/** A short line for the status bar tooltip: "all practices", "no practices" or the titles. */
export function describePractices(catalog: Practice[], selected: string[] | undefined, t: Translate = english): string {
  if (selected === undefined) return t("all practices");
  if (!selected.length) return t("no practices: no rule runs");
  return selected.map((id) => {
    const practice = catalog.find((p) => p.id === id);
    return practice ? practiceText(practice, t).title : id;
  }).join(", ");
}

/** Titles of the practices of a rule that the selection leaves out; empty when a chosen practice has it or all are chosen. */
export function unchosenPractices(catalog: Practice[], selected: string[] | undefined, ruleId: string, t: Translate = english): string[] {
  if (selected === undefined) return [];
  const owners = catalog.filter((p) => p.rules.includes(ruleId));
  if (owners.some((p) => selected.includes(p.id))) return [];
  return owners.map((p) => practiceText(p, t).title);
}
