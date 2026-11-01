package services

import "shop/domain"

type OrderService struct {
	Repo domain.Repo
	Last domain.Entity
}
