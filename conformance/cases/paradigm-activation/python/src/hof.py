from typing import Callable


def twice(f: Callable[[int], int], x: int) -> int:
    return f(f(x))
