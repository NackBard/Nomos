package shop.services

import shop.domain.Entity
import shop.domain.Repo

class OrderService {
    lateinit var repo: Repo
    lateinit var last: Entity
}
