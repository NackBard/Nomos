package cx

type Base struct {
}

func (b *Base) Make() any {
	return &Derived{}
}

type Derived struct {
	Base
}
