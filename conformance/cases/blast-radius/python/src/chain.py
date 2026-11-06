class C1: ...


class C2:
    prev: C1 | None = None


class C3:
    prev: C2 | None = None


class C4:
    prev: C3 | None = None
