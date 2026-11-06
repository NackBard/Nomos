class N1:
    def next(self):
        return N2()


class N2:
    def next(self):
        return N3()

    def skip(self):
        return N4()


class N3:
    def next(self):
        return N4()


class N4:
    def next(self):
        return N5()


class N5:
    def next(self):
        return N1()
