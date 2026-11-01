package alg

func Constant(a int) int {
	return a + 1
}

func Linear(items []int) int {
	n := 0
	for _, x := range items {
		n += x
	}
	return n
}

func Quadratic(a, b []int) int {
	n := 0
	for _, x := range a {
		for _, y := range b {
			n += x * y
		}
	}
	return n
}

func Halving(size int) int {
	steps := 0
	for i := size; i > 0; i /= 2 {
		steps++
	}
	return steps
}

func LinearLog(items []int) int {
	n := 0
	for _, x := range items {
		n += Halving(x)
	}
	return n
}

func Fixed() int {
	n := 0
	for i := 0; i < 10; i++ {
		n += i
	}
	return n
}

func Fib(n int) int {
	if n < 2 {
		return n
	}
	return Fib(n-1) + Fib(n-2)
}

func Factorial(n int) int {
	if n < 2 {
		return 1
	}
	return n * Factorial(n-1)
}

func Search(items []int, low, high int) int {
	if low >= high {
		return low
	}
	mid := (low + high) / 2
	if items[mid] > 0 {
		return Search(items, low, mid)
	}
	return Search(items, mid, high)
}

func CubicViaCallee(items []int) int {
	n := 0
	for range items {
		n += Quadratic(items, items)
	}
	return n
}
