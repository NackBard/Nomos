counter = 0


def add(a: int, b: int) -> int:
    return a + b


def bump() -> None:
    global counter
    counter += 1
