"""Finding texts: rendering, and every template of the source is a template of its rule in spec/rules (spec/l10n.md)."""
import ast
import os
import re
import sys
import unittest

here = os.path.dirname(os.path.abspath(__file__))
package = os.path.join(here, "..", "nomos_python")
sys.path.insert(0, os.path.join(here, ".."))

from nomos_python.config import spec_rules  # noqa: E402
from nomos_python.text import fixed, render, tx  # noqa: E402

# Helpers outside a detector that report for one rule.
HELPERS = {"check_secret": "SEC001"}


def source_templates():
    found = []
    for name in sorted(os.listdir(package)):
        if not name.endswith(".py") or name == "text.py":
            continue
        path = os.path.join(package, name)
        with open(path, encoding="utf-8") as f:
            tree = ast.parse(f.read())

        def visit(node, rule):
            if isinstance(node, ast.FunctionDef):
                match = re.fullmatch(r"_([a-z]{2,4}\d{3})", node.name)
                if match:
                    rule = match.group(1).upper()
                elif node.name in HELPERS:
                    rule = HELPERS[node.name]
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "tx":
                first = node.args[0] if node.args else None
                literal = first.value if isinstance(first, ast.Constant) and isinstance(first.value, str) else None
                found.append((rule, literal, f"{name}:{node.lineno}"))
            for child in ast.iter_child_nodes(node):
                visit(child, rule)

        visit(tree, "")
    return found


class TextTest(unittest.TestCase):
    def test_a_text_keeps_its_template_and_renders_the_arguments(self):
        text = tx("{0} has {1}% coverage, D = {2}, {{3}}", "a.py", 42, fixed(0.5, 2))
        self.assertEqual(text.template, "{0} has {1}% coverage, D = {2}, {{3}}")
        self.assertEqual(text.args, ("a.py", "42", "0.50"))
        self.assertEqual(render(text), "a.py has 42% coverage, D = 0.50, {3}")

    def test_a_fractional_number_must_be_formatted_by_the_caller(self):
        with self.assertRaises(TypeError):
            tx("{0}", 0.5)

    def test_fixed_rounds_half_up_as_javascript_does(self):
        self.assertEqual(fixed(0.125, 2), "0.13")
        self.assertEqual(fixed(2.5, 0), "3")

    def test_every_text_of_a_finding_is_a_template_of_its_rule(self):
        spec = {r["id"]: {m["text"] for m in (r.get("messages") or {}).values()} for r in spec_rules()}
        found = source_templates()
        self.assertGreater(len(found), 50, f"only {len(found)} texts found: the scan is broken")
        problems = []
        for rule, template, where in found:
            if template is None:
                problems.append(f"{where}: the template is not a literal")
            elif not rule:
                problems.append(f"{where}: tx outside a detector")
            elif template not in spec.get(rule, set()):
                problems.append(f"{where} {rule}: not in spec: {template}")
        self.assertEqual(problems, [])


if __name__ == "__main__":
    unittest.main()
