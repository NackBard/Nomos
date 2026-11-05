import fs from "node:fs";
import { ordinal } from "./config.ts";
import { round } from "./metrics.ts";

/** Line coverage from a Cobertura or LCOV report (spec/metrics.md). */
export class Coverage {
  private files = new Map<string, Map<number, number>>();

  /** Reads a report; the extension .xml means Cobertura. */
  static load(file: string): Coverage {
    const text = fs.readFileSync(file, "utf8");
    const c = new Coverage();
    if (file.toLowerCase().endsWith(".xml")) {
      for (const cls of text.matchAll(/<class\b[^>]*\bfilename="([^"]*)"[^>]*>([\s\S]*?)<\/class>/g)) {
        const lines = c.files.get(cls[1]) ?? new Map<number, number>();
        for (const line of cls[2].matchAll(/<line\b[^>]*>/g)) {
          const number = /\bnumber="(\d+)"/.exec(line[0]);
          const hits = /\bhits="(\d+)"/.exec(line[0]);
          if (number && hits) lines.set(Number(number[1]), Math.max(lines.get(Number(number[1])) ?? 0, Number(hits[1])));
        }
        c.files.set(cls[1], lines);
      }
      return c;
    }
    let current: Map<number, number> | undefined;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith("SF:")) {
        current = new Map();
        c.files.set(line.slice(3), current);
      } else if (line.startsWith("DA:") && current) {
        const [number, hits] = line.slice(3).split(",");
        if (hits !== undefined) current.set(Number(number), Number(hits));
      }
    }
    return c;
  }

  /** The covered share of a file, undefined when the report does not mention it. */
  percent(file: string): number | undefined {
    for (const name of [...this.files.keys()].sort(ordinal)) {
      const reported = name.replaceAll("\\", "/").toLowerCase();
      const own = file.toLowerCase();
      if (reported === own || reported.endsWith(`/${own}`)) {
        const lines = this.files.get(name)!;
        if (lines.size === 0) return 100;
        const covered = [...lines.values()].filter((hits) => hits > 0).length;
        return round((100 * covered) / lines.size, 4);
      }
    }
    return undefined;
  }
}
