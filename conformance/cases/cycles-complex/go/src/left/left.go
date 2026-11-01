package left

import "cx/right"

type X1 struct {
	Next *X2
}

type X2 struct {
	Back   *X1
	Bridge *right.Y1
}
