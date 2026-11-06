package shop.infra

import shop.domain.Entity
import shop.domain.Repo

class SqlRepo : Repo {
    lateinit var cache: Entity
}
