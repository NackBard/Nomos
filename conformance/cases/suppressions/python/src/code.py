def reported(a: list[int]) -> int:
    n = 0
    for x in a:
        for y in a:
            n += x * y
    return n


# nomos-disable-next-line ALG001
def next_line(a: list[int]) -> int:
    n = 0
    for x in a:
        for y in a:
            n += x * y
    return n


def same(a: list[int]) -> int:  # nomos-disable-line ALG001
    n = 0
    for x in a:
        for y in a:
            n += x * y
    return n


# nomos-disable-next-line CC001
def other_rule(a: list[int]) -> int:
    n = 0
    for x in a:
        for y in a:
            n += x * y
    return n


def reasoned(a: list[int]) -> int:  # nomos-disable-line alg001, CC003 -- input is bounded
    n = 0
    for x in a:
        for y in a:
            n += x * y
    return n
