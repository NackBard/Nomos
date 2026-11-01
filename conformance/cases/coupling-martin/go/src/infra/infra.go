package infra

import "shop/domain"

type SqlRepo struct {
	domain.Repo
	Cache domain.Entity
}
