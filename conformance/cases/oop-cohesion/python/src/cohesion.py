from dataclasses import dataclass


@dataclass
class Data:
    value: int = 0
    other: int = 0


class Mixed:
    _a: int = 0
    _b: int = 0
    source: Data = Data()

    def inc_a(self) -> None:
        self._a += 1

    def read_a(self) -> int:
        return self._a

    def inc_b(self) -> None:
        self._b += 1

    def peek(self) -> int:
        return self.source.value + self.source.other


class Derived(Mixed): ...
