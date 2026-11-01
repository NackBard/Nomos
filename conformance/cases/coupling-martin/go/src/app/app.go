package app

import (
	"shop/infra"
	"shop/services"
)

type Program struct {
	Service services.OrderService
	Repo    infra.SqlRepo
}
