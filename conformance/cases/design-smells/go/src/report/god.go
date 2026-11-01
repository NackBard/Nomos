package report

import "smell/data"

type God struct {
	a int
	b int
	c int
	d int
}

func (g *God) One(order *data.Order) int {
	if order.Price > 0 {
		return g.a
	}
	return 0
}

func (g *God) Two(order *data.Order) int {
	if order.Tax > 0 {
		return g.b
	}
	return 0
}

func (g *God) Three(order *data.Order) int {
	if order.Fee > 0 {
		return g.c
	}
	return 0
}

func (g *God) Four(order *data.Order) int {
	if order.Price > 0 {
		return g.d
	}
	return 0
}
