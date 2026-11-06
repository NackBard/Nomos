password = "hunter22"


def find(name: str) -> str:
    return "SELECT id FROM items WHERE name = '" + name + "'"


def total(a: int, b: int, c: int, d: int, e: int, f: int) -> int:
    return a + b + c + d + e + f
