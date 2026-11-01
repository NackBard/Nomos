package hof

func Twice(f func(int) int, x int) int {
	return f(f(x))
}
