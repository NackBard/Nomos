"""The suppressions of one file (spec/suppressions.md)."""
from __future__ import annotations

import re

_directive = re.compile(r"nomos-disable(-next-line|-line)?([ \t,\w.*]*)")


class Directives:
    def __init__(self) -> None:
        self.file: list = []
        self.lines: dict = {}

    def add(self, comment: str, start: int, end: int) -> None:
        """Reads a comment spanning lines start to end."""
        match = _directive.search(comment)
        if not match:
            return
        ids = [i for i in re.split(r"[ \t,]+", match.group(2)) if i]
        if not ids:
            ids = ["*"]
        if match.group(1) == "-line":
            self.lines.setdefault(start, []).extend(ids)
        elif match.group(1) == "-next-line":
            self.lines.setdefault(end + 1, []).extend(ids)
        else:
            self.file.extend(ids)

    def covers(self, rule: str, line: int) -> bool:
        for ids in (self.file, self.lines.get(line, [])):
            if any(i == "*" or i.lower() == rule.lower() for i in ids):
                return True
        return False
