package report

import "smell/data"

type Printer struct {
	copies int
	width  int
	depth  int
}

func NewPrinter() *Printer {
	return &Printer{copies: 1}
}

func (p *Printer) Envy(order *data.Order) int {
	return order.Price + order.Tax + order.Fee
}

func (p *Printer) Balanced(order *data.Order) int {
	return order.Price + order.Tax + order.Fee + p.copies + p.width + p.depth
}

func (p *Printer) Few(order *data.Order) int {
	return order.Price + order.Tax
}

func Sum(order *data.Order) int {
	return order.Price + order.Tax + order.Fee
}
