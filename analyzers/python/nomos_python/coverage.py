"""Line coverage from a Cobertura or LCOV report (spec/metrics.md)."""
from __future__ import annotations

import re

from .text import js_round


class Coverage:
    def __init__(self) -> None:
        self.files: dict = {}

    @staticmethod
    def load(file: str) -> "Coverage":
        """Reads a report; the extension .xml means Cobertura."""
        with open(file, encoding="utf-8-sig") as f:
            text = f.read()
        c = Coverage()
        if file.lower().endswith(".xml"):
            for cls in re.finditer(r'<class\b[^>]*\bfilename="([^"]*)"[^>]*>([\s\S]*?)</class>', text):
                lines = c.files.setdefault(cls.group(1), {})
                for line in re.finditer(r"<line\b[^>]*>", cls.group(2)):
                    number = re.search(r'\bnumber="(\d+)"', line.group(0))
                    hits = re.search(r'\bhits="(\d+)"', line.group(0))
                    if number and hits:
                        n = int(number.group(1))
                        lines[n] = max(lines.get(n, 0), int(hits.group(1)))
            return c
        current = None
        for raw in re.split(r"\r?\n", text):
            line = raw.strip()
            if line.startswith("SF:"):
                current = {}
                c.files[line[3:]] = current
            elif line.startswith("DA:") and current is not None:
                parts = line[3:].split(",")
                if len(parts) >= 2:
                    current[int(parts[0])] = int(parts[1])
        return c

    def percent(self, file: str):
        """The covered share of a file, None when the report does not mention it."""
        own = file.lower()
        for name in sorted(self.files):
            reported = name.replace("\\", "/").lower()
            if reported == own or reported.endswith("/" + own):
                lines = self.files[name]
                if not lines:
                    return 100
                covered = sum(1 for hits in lines.values() if hits > 0)
                return js_round(100 * covered / len(lines) * 10000) / 10000
        return None
