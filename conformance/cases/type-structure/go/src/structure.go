package ts

import "strings"

type Shape interface {
	Area() float64
}

type Named interface {
	Shape
	Name() string
}

type Base struct {
	name string
}

func (b Base) Name() string { return b.name }

type Square struct {
	Base
	*strings.Builder
	Side  float64
	cells []*Cell
	byKey map[string]Cell
}

func (s *Square) Area() float64 { return s.Side * s.Side }

func (s *Square) Resize(by float64, labels ...string) (old float64, err error) {
	old = s.Side
	s.Side *= by
	return old, nil
}

type Cell struct{ X, Y int }

type Box[T any] struct{ Item T }

func Paint(s Shape) float64 { return s.Area() }
