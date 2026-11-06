from domain import Entity, Repo


class OrderService:
    repo: Repo | None = None
    last: Entity = Entity()
