def none(a: int) -> int:
    return a


def grows(items: list[int]) -> list[int]:
    result: list[int] = []
    for x in items:
        result.append(x)
    return result


def grid(a: list[int], b: list[int]) -> int:
    result: list[int] = []
    for x in a:
        for y in b:
            result.append(x + y)
    return len(result)


def sized(n: int) -> list[int]:
    return [0] * n


def literal() -> list[int]:
    return [0] * 8


def deep(n: int) -> int:
    if n < 1:
        return 0
    return deep(n - 1)


class Box:
    size: int = 0


def new_in_nested(a: list[int], b: list[int]) -> int:
    n = 0
    for x in a:
        for y in b:
            n += Box().size + x + y
    return n


def new_in_loop(a: list[int]) -> int:
    n = 0
    for x in a:
        n += Box().size + x
    return n
