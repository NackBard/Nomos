def constant(a: int) -> int:
    return a + 1


def linear(items: list[int]) -> int:
    n = 0
    for x in items:
        n += x
    return n


def quadratic(a: list[int], b: list[int]) -> int:
    n = 0
    for x in a:
        for y in b:
            n += x * y
    return n


def halving(size: int) -> int:
    steps = 0
    i = size
    while i > 0:
        i //= 2
        steps += 1
    return steps


def linear_log(items: list[int]) -> int:
    n = 0
    for x in items:
        n += halving(x)
    return n


def fixed() -> int:
    n = 0
    for i in range(10):
        n += i
    return n


def fib(n: int) -> int:
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)


def factorial(n: int) -> int:
    if n < 2:
        return 1
    return n * factorial(n - 1)


def search(items: list[int], low: int, high: int) -> int:
    if low >= high:
        return low
    mid = (low + high) // 2
    if items[mid] > 0:
        return search(items, low, mid)
    return search(items, mid, high)


def cubic_via_callee(items: list[int]) -> int:
    n = 0
    for _ in items:
        n += quadratic(items, items)
    return n
