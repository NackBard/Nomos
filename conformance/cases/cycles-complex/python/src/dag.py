class Top:
    def left(self):
        return Mid1()

    def right(self):
        return Mid2()


class Mid1:
    def end(self):
        return Bottom()


class Mid2:
    def end(self):
        return Bottom()


class Bottom: ...


class Self:
    def next(self):
        return Self()
