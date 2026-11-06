"""Behavior of the analyzer on small projects written to a temporary folder (D-057)."""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest

here = os.path.dirname(os.path.abspath(__file__))
main = os.path.join(here, "..", "main.py")
sys.path.insert(0, os.path.join(here, ".."))

from nomos_python.project import scan  # noqa: E402


def run(files: dict, *args):
    """Writes the files, runs `analyze` in a separate interpreter and returns the exit code, facts and stderr."""
    with tempfile.TemporaryDirectory() as root:
        for name, text in files.items():
            path = os.path.join(root, name)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write(textwrap.dedent(text))
        command = [sys.executable, "-I", main, "analyze", "--root", root, *args]
        result = subprocess.run(command, capture_output=True, cwd=root)
        facts = json.loads(result.stdout.decode("utf-8")) if result.stdout else None
        return result.returncode, facts, result.stderr.decode("utf-8")


def by_id(items):
    return {x["id"]: x for x in items}


def edges(facts):
    return {(d["from"], d["to"], d["kind"], d["phase"]) for d in facts["dependencies"] if not d["external"]}


class AnalyzerTest(unittest.TestCase):
    def test_elif_stays_on_the_level_of_its_if_and_else_if_nests(self):
        _, facts, _ = run({"m.py": """
            def chain(a):
                if a > 1:
                    return 1
                elif a > 0:
                    return 2
                return 0


            def nested(a):
                if a > 1:
                    return 1
                else:
                    if a > 0:
                        return 2
                return 0
            """})
        functions = by_id(facts["functions"])
        self.assertEqual(functions["m.chain"]["metrics"]["cyclomatic"], 3)
        self.assertEqual(functions["m.chain"]["metrics"]["maxNesting"], 1)
        self.assertEqual(functions["m.nested"]["metrics"]["cyclomatic"], 3)
        self.assertEqual(functions["m.nested"]["metrics"]["maxNesting"], 2)

    def test_type_checking_imports_and_annotations_are_type_only_and_close_no_cycle(self):
        _, facts, _ = run({
            "a.py": """
                from __future__ import annotations
                from typing import TYPE_CHECKING
                if TYPE_CHECKING:
                    from b import B


                class A:
                    peer: B | None = None
                """,
            "b.py": """
                from a import A


                class B:
                    def make(self):
                        return A()
                """,
        })
        self.assertIn(("a", "b", "import", "type-only"), edges(facts))
        self.assertIn(("b", "a", "import", "runtime"), edges(facts))
        self.assertIn(("a.A", "b.B", "type-ref", "type-only"), edges(facts))
        self.assertIn(("b.B", "a.A", "call", "runtime"), edges(facts))
        self.assertEqual(facts["cycles"], [])

    def test_imports_resolve_through_a_src_folder_and_relative_imports(self):
        _, facts, _ = run({
            "src/shop/__init__.py": "",
            "src/shop/orders.py": """
                from .money import Money


                def total() -> Money:
                    return Money()
                """,
            "src/shop/money.py": "class Money: ...\n",
            "tests/test_orders.py": """
                from shop.orders import total


                def test_total():
                    assert total()
                """,
        })
        modules = by_id(facts["modules"])
        self.assertIn("src.shop", modules)
        self.assertIn(("src.shop.orders", "src.shop.money", "import", "runtime"), edges(facts))
        self.assertIn(("tests.test_orders", "src.shop.orders", "import", "runtime"), edges(facts))
        self.assertIn(("tests.test_orders.test_total", "src.shop.orders.total", "call", "runtime"), edges(facts))

    def test_a_name_imported_inside_a_function_is_resolved(self):
        _, facts, _ = run({
            "a.py": """
                def run():
                    from b import helper
                    return helper()
                """,
            "b.py": "def helper():\n    return 1\n",
        })
        self.assertIn(("a.run", "b.helper", "call", "runtime"), edges(facts))
        self.assertIn(("a", "b", "import", "runtime"), edges(facts))

    def test_an_f_string_is_one_token_on_every_python_version(self):
        tokens, _, loc, broken = scan('x = f"{a} and {b!r:>10}"\n')
        self.assertFalse(broken)
        self.assertEqual([t.kind for t in tokens], ["name", "op", "string"])
        self.assertEqual(loc, 1)

    def test_global_state_is_rebinding_or_a_collection_but_not_a_constant(self):
        _, facts, _ = run({"g.py": """
            LIMIT = 10
            name = "x"
            cache = {}
            counter = 0


            def bump():
                global counter
                counter += 1
            """}, "--config", "")
        module = by_id(facts["modules"])["g"]
        state = [e for e in module["paradigmEvidence"] if e["kind"] == "str.global-state"]
        self.assertEqual(state[0]["examples"], ["g.cache", "g.counter"])

    def test_practices_switch_rules_off_with_the_shared_message(self):
        with tempfile.TemporaryDirectory() as folder:
            config = os.path.join(folder, "nomos.json")
            with open(config, "w", encoding="utf-8") as f:
                json.dump({"schemaVersion": "1.1.0", "analyzers": [{"language": "python", "command": ["x"]}], "practices": ["security"]}, f)
            _, facts, _ = run({"m.py": "def f():\n    return 1\n"}, "--config", config)
        skipped = [s for s in facts["skippedRules"] if s["ruleId"] == "CC001"]
        self.assertEqual(skipped[0]["reason"], "disabled-by-config")
        self.assertIn("which is not selected", skipped[0]["message"])

    def test_exit_codes(self):
        code, facts, _ = run({"ok.py": "x = 1\n", "bad.py": "def (:\n"})
        self.assertEqual(code, 4)
        self.assertFalse(by_id([{**f, "id": f["path"]} for f in facts["files"]])["bad.py"]["parsed"])
        code, _, stderr = run({"ok.py": "x = 1\n"}, "--rules", "NOPE001")
        self.assertEqual(code, 2)
        with tempfile.TemporaryDirectory() as folder:
            config = os.path.join(folder, "nomos.json")
            with open(config, "w", encoding="utf-8") as f:
                json.dump({"schemaVersion": "1.1.0", "analyzers": [], "practices": ["no-such-practice"]}, f)
            code, _, stderr = run({"ok.py": "x = 1\n"}, "--config", config)
        self.assertEqual(code, 3)
        self.assertIn("unknown practice", stderr)

    def test_an_empty_folder_is_an_empty_analysis(self):
        code, facts, _ = run({"readme.txt": "no python here\n"})
        self.assertEqual(code, 0)
        self.assertEqual(facts["modules"], [])
        self.assertEqual([d["code"] for d in facts["diagnostics"]], ["no-files"])

    def test_output_is_deterministic(self):
        files = {"a.py": "class A:\n    def f(self, xs: list[int]) -> int:\n        return sum(x for x in xs if x in xs)\n", "b.py": "from a import A\n"}
        first = run(files)
        second = run(files)
        self.assertEqual(first[1], second[1])


if __name__ == "__main__":
    unittest.main()
