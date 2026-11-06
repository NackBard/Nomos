class A:
    tag: int = 0


class B: ...


class C: ...


def route(x: object) -> int:
    if isinstance(x, A):
        return 1
    if isinstance(x, B):
        return 2
    if isinstance(x, C):
        return 3
    return 0
