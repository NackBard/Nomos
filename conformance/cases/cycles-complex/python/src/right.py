class Y1:
    def next(self):
        return Y2()


class Y2:
    def back(self):
        return Y1()
