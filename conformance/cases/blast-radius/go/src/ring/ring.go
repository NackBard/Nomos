package ring

import "blast/chain"

type R1 struct {
	Next *R2
}

type R2 struct {
	Next *R3
}

type R3 struct {
	Next *R1
	End  *Leaf
}

type Tail struct {
	Head *R1
}

type Leaf struct {
	Last *chain.C4
}
