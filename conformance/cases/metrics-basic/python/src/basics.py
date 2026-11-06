def straight(a: int) -> int:
    return a + 1


# A comment line: it counts toward the lines of the file but not toward loc.
def branches(a: int, b: int) -> int:
    if a > 0 and b > 0:
        return 1
    elif a < 0 or b < 0:
        return -1

    return 0


def loops(items: list[int], limit: int) -> int:
    total = 0
    for item in items:
        for i in range(limit):
            if item > i:
                total += item

    return total


def switches(kind: int, text: str) -> str:
    match kind:
        case 1:
            return "one"
        case 2:
            return "two"
        case _:
            return text
