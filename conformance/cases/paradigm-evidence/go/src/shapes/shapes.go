package shapes

type Shape interface {
}

type ShapeBase struct {
	ID int
}

type Square struct {
	ShapeBase
	Side int
}
