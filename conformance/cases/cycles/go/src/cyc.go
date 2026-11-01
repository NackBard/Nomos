package cyc

type A struct {
	Next *B
}

type B struct {
	Next *C
}

type C struct {
	Next *A
}

type D struct {
	Peer *E
	Ring *A
}

type E struct {
	Peer *D
}
