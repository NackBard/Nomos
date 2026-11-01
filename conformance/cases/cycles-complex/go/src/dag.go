package cx

type Top struct {
	M1 *Mid1
	M2 *Mid2
}

type Mid1 struct {
	End *Bottom
}

type Mid2 struct {
	End *Bottom
}

type Bottom struct {
}

type Self struct {
	Next *Self
}
