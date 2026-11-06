class Bottom:
    def size(self) -> int:
        return 1


class Left(Bottom): ...


class Right:
    shared: Bottom | None = None


class Top:
    left: Left | None = None
    right: Right | None = None
