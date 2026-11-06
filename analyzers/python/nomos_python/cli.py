"""The protocol of docs/ARCHITECTURE.md: facts to stdout, SARIF to the file named by --sarif, messages to stderr."""
from __future__ import annotations

import os
import sys
import traceback

SUCCESS, UNEXPECTED, USAGE, BAD_INPUT, PARTIAL = 0, 1, 2, 3, 4


def _usage(message: str) -> int:
    sys.stderr.write(f"{message}\nUsage: nomos-python manifest | analyze --root <path> [--sarif <file>] [--config <nomos.json>] [--rules <ids>]\n")
    return USAGE


def _write(text: str) -> None:
    sys.stdout.buffer.write(text.encode("utf-8"))
    sys.stdout.flush()


def _analyze(args: list) -> int:
    from .config import ConfigError, load_config
    from .facts import analyze
    from .project import Project
    from .rules import SUPPORTED

    values = {}
    for i in range(0, len(args), 2):
        if i + 1 >= len(args):
            return _usage(f"Missing value for {args[i]}")
        if args[i] not in ("--root", "--sarif", "--config", "--rules", "--files"):
            return _usage(f"Unknown option: {args[i]}")
        values[args[i]] = args[i + 1]  # --files is ignored: the analyzer always reads the whole root (partialAnalysis = false)
    root = values.get("--root")
    if not root:
        return _usage("--root is required")
    if not os.path.isdir(root):
        sys.stderr.write(f"error: root does not exist: {root}\n")
        return BAD_INPUT
    try:
        config = load_config(values.get("--config"))
    except ConfigError as e:
        sys.stderr.write(f"error: {e}\n")
        return BAD_INPUT
    selected = None
    if values.get("--rules"):
        selected = set()
        for raw in values["--rules"].split(","):
            rule = raw.strip()
            if rule not in SUPPORTED:
                return _usage(f"Unknown rule: {rule}")
            selected.add(rule)
    include, exclude = config.scope()
    project = Project(root)
    project.load(include, exclude)
    facts, partial = analyze(project, root, values.get("--sarif"), selected, config)
    _write(facts)
    return PARTIAL if partial else SUCCESS  # findings never change the exit code, only an incomplete result does


def main(argv: list) -> int:
    if sys.version_info < (3, 10):
        sys.stderr.write("error: Nomos needs Python 3.10 or newer\n")
        return BAD_INPUT
    try:
        if argv == ["manifest"]:
            import json

            from .facts import manifest

            _write(json.dumps(manifest(), indent=2) + "\n")
            return SUCCESS
        if argv and argv[0] == "analyze":
            return _analyze(argv[1:])
        return _usage(f"Unknown command or option: {' '.join(argv)}")
    except RecursionError:
        sys.stderr.write("error: the syntax tree is too deep\n" + traceback.format_exc())
        return UNEXPECTED
    except Exception:  # an analyzer bug must not look like a finding: exit code 1 and the stack for the author
        sys.stderr.write("error: " + traceback.format_exc())
        return UNEXPECTED
