package chain

type C1 struct {
}

type C2 struct {
	Prev *C1
}

type C3 struct {
	Prev *C2
}

type C4 struct {
	Prev *C3
}
