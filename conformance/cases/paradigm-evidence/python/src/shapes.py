from typing import Protocol


class Shape(Protocol): ...


class ShapeBase:
    id: int = 0


class Square(ShapeBase):
    side: int = 0
