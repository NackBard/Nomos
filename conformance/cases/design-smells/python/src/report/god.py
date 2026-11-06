from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from data.order import Order


class God:
    _a: int = 0
    _b: int = 0
    _c: int = 0
    _d: int = 0

    def one(self, order: Order) -> int:
        if order.price > 0:
            return self._a
        return 0

    def two(self, order: Order) -> int:
        if order.tax > 0:
            return self._b
        return 0

    def three(self, order: Order) -> int:
        if order.fee > 0:
            return self._c
        return 0

    def four(self, order: Order) -> int:
        if order.price > 0:
            return self._d
        return 0
