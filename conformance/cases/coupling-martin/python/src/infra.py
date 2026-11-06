from domain import Entity, Repo


class SqlRepo(Repo):
    cache = Entity()
