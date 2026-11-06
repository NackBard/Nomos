from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from chain import C4


class R1:
    def next(self):
        return R2()


class R2:
    def next(self):
        return R3()


class R3:
    end: Leaf | None = None

    def next(self):
        return R1()


class Tail:
    head = R1()


class Leaf:
    last: C4 | None = None
