from right import Y1


class X1:
    def next(self):
        return X2()


class X2:
    def back(self):
        return X1()

    def bridge(self):
        return Y1()
