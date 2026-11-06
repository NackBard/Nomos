from abc import ABC, abstractmethod
from enum import Enum
from typing import ClassVar, Generic, NamedTuple, Protocol, TypeVar

T = TypeVar("T")


class Shape(Protocol):
    def area(self) -> float: ...


class Named(Shape, Protocol):
    label: str

    def name(self) -> str: ...


class Cell:
    def __init__(self) -> None:
        self.x = 0
        self.y = 0


class Base(ABC):
    def __init__(self, title: str) -> None:
        self._title = title

    def name(self) -> str:
        return self._title

    @abstractmethod
    def area(self) -> float: ...


class Square(Base):
    count: ClassVar[int] = 0
    side: float = 1.0
    cells: list[Cell]
    by_key: dict[str, Cell]
    _secret: Cell | None = None

    def __init__(self) -> None:
        super().__init__("square")
        self.cells = []
        self.by_key = {}

    @staticmethod
    def create() -> "Square":
        return Square()

    @property
    def perimeter(self) -> float:
        return self.side * 4

    @perimeter.setter
    def perimeter(self, value: float) -> None:
        self.side = value / 4

    def area(self) -> float:
        return self.side * self.side

    def resize(self, by: float, *labels: str) -> tuple[float, tuple[str, ...]]:
        old = self.side
        self.side *= by
        return old, labels


class Circle:
    label: str = "circle"

    def area(self) -> float:
        return 3.0

    def name(self) -> str:
        return self.label


class Color(Enum):
    RED = 1
    GREEN = 2


class Box(Generic[T]):
    item: T | None = None


class Point(NamedTuple):
    x: float
    y: float


def paint(s: Shape) -> float:
    return s.area()


twice = lambda n: n * 2  # noqa: E731
