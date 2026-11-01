package cx

type P struct {
	Next *Q
}

type Q struct {
	Back *P
	Side *S
}

type S struct {
	Return *Q
}
