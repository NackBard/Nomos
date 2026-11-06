# nomos-disable ALG001
def pairs(a: list[int]) -> int:
    n = 0
    for x in a:
        for y in a:
            n += x * y
    return n
