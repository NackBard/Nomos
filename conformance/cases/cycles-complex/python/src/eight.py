class P:
    def next(self):
        return Q()


class Q:
    def back(self):
        return P()

    def side(self):
        return S()


class S:
    def back(self):
        return Q()
