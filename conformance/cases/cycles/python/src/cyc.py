from __future__ import annotations


class A:
    def next(self) -> B:
        return B()


class B:
    def next(self) -> C:
        return C()


class C:
    def next(self) -> A:
        return A()


class D:
    def __init__(self) -> None:
        self.peer = E()
        self.ring = A()


class E:
    def peer(self) -> D:
        return D()


# Only annotations refer to each other here: no cycle exists at run time.
class F:
    peer: G | None = None


class G:
    peer: F | None = None
