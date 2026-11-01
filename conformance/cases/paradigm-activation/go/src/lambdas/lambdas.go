package lambdas

import "slices"

func Scan(xs []int) bool {
	return slices.ContainsFunc(xs, func(x int) bool {
		return slices.ContainsFunc(xs, func(y int) bool {
			return y == x
		})
	})
}
