from data.order import Order


class Printer:
    _copies: int = 1
    _width: int = 0
    _depth: int = 0

    def envy(self, order: Order) -> int:
        return order.price + order.tax + order.fee

    def balanced(self, order: Order) -> int:
        return order.price + order.tax + order.fee + self._copies + self._width + self._depth

    def few(self, order: Order) -> int:
        return order.price + order.tax


def new_printer() -> Printer:
    return Printer()


def total(order: Order) -> int:
    return order.price + order.tax + order.fee
