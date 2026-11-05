/** The suppressions of one file (spec/suppressions.md). */
export class Directives {
  file: string[] = [];
  lines = new Map<number, string[]>();

  /** Reads a comment spanning lines start to end. */
  add(comment: string, start: number, end: number): void {
    const match = /nomos-disable(-next-line|-line)?([ \t,\w.*]*)/.exec(comment);
    if (!match) return;
    let ids = match[2].split(/[ \t,]+/).filter((id) => id !== "");
    if (ids.length === 0) ids = ["*"];
    if (match[1] === "-line") this.lines.set(start, [...(this.lines.get(start) ?? []), ...ids]);
    else if (match[1] === "-next-line") this.lines.set(end + 1, [...(this.lines.get(end + 1) ?? []), ...ids]);
    else this.file.push(...ids);
  }

  covers(rule: string, line: number): boolean {
    return [this.file, this.lines.get(line) ?? []].some((list) => list.some((id) => id === "*" || id.toLowerCase() === rule.toLowerCase()));
  }
}
