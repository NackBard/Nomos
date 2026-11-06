class Base:
    def make(self) -> object:
        return Derived()


class Derived(Base): ...
