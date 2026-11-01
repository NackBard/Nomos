package alg

func None(a int) int {
	return a
}

func Grows(items []int) []int {
	list := []int{}
	for _, x := range items {
		list = append(list, x)
	}
	return list
}

func Grid(a, b []int) int {
	list := []int{}
	for _, x := range a {
		for _, y := range b {
			list = append(list, x+y)
		}
	}
	return len(list)
}

func Sized(n int) []int {
	return make([]int, n)
}

func Literal() []int {
	return make([]int, 8)
}

func Deep(n int) int {
	if n < 1 {
		return 0
	}
	return Deep(n - 1)
}

type Box struct {
	Size int
}

func NewInNested(a, b []int) int {
	n := 0
	for _, x := range a {
		for _, y := range b {
			n += (&Box{}).Size + x + y
		}
	}
	return n
}

func NewInLoop(a []int) int {
	n := 0
	for _, x := range a {
		n += (&Box{}).Size + x
	}
	return n
}
