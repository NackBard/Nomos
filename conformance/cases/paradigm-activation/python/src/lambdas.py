def scan(xs: list[int]) -> bool:
    return any(map(lambda x: any(map(lambda y: y == x, xs)), xs))
