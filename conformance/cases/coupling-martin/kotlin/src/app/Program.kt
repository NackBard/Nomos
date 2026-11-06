package shop.app

import shop.infra.SqlRepo
import shop.services.OrderService

class Program {
    lateinit var service: OrderService
    lateinit var repo: SqlRepo
}
