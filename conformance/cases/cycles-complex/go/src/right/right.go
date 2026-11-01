package right

type Y1 struct {
	Next *Y2
}

type Y2 struct {
	Back *Y1
}
