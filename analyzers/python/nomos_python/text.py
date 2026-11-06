"""Finding texts as templates of spec/rules with their arguments (spec/l10n.md)."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Text:
    """The English template ({0}, {1}...) and its arguments; a client can show it in another language."""

    template: str
    args: tuple


def tx(template: str, *args) -> Text:
    """Builds a text from a literal template of spec/rules; the tests read these calls from the source."""
    return Text(template, tuple(_argument(a) for a in args))


def _argument(value) -> str:
    if isinstance(value, bool):
        raise TypeError("a boolean is not an argument of a finding text")
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        raise TypeError(f"argument {value} is not an integer; format it with fixed()")
    return value


def fixed(value: float, digits: int) -> str:
    """A number with a fixed count of decimals, culture-free and rounded half away from zero, as JavaScript does."""
    scale = 10 ** digits
    rounded = js_round(value * scale) / scale
    return f"{rounded:.{digits}f}"


def js_round(value: float) -> float:
    """Math.round of JavaScript: half rounds up. Python's round would round half to even."""
    import math

    return float(math.floor(value + 0.5))


def render(text: Text) -> str:
    """Puts the arguments into the template; {{ and }} are braces."""
    out = []
    t = text.template
    i = 0
    while i < len(t):
        c = t[i]
        if c in "{}" and i + 1 < len(t) and t[i + 1] == c:
            out.append(c)
            i += 2
            continue
        if c == "{":
            end = t.index("}", i)
            out.append(text.args[int(t[i + 1:end])])
            i = end + 1
            continue
        out.append(c)
        i += 1
    return "".join(out)
