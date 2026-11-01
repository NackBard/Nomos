package diamond

type Bottom struct {
}

func (b Bottom) Size() int {
	return 1
}

type Left struct {
	Bottom
}

type Right struct {
	Shared *Bottom
}

type Top struct {
	L *Left
	R *Right
}
