package domain

import (
	outer "app/domain"
	"app/web"
)

type Rich struct {
	Base outer.Entity
	Page web.Page
}
