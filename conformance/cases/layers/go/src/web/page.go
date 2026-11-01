package web

import (
	"app/domain"
	"app/extra"
	"app/services"
)

type Page struct {
	Service  services.Svc
	Shortcut domain.Entity
	Helper   extra.Tool
}
