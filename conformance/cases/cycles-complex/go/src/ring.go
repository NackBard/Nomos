package cx

type N1 struct {
	Next *N2
}

type N2 struct {
	Next *N3
	Skip *N4
}

type N3 struct {
	Next *N4
}

type N4 struct {
	Next *N5
}

type N5 struct {
	Next *N1
}
