package dispatch

type A struct {
	Tag int
}

type B struct {
}

type C struct {
}

func Route(x any) int {
	switch x.(type) {
	case A:
		return 1
	case B:
		return 2
	case C:
		return 3
	}
	return 0
}
