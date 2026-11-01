package sup

func Reported(a []int) int { n := 0; for _, x := range a { for _, y := range a { n += x * y } }; return n }

// nomos-disable-next-line ALG001
func Next(a []int) int { n := 0; for _, x := range a { for _, y := range a { n += x * y } }; return n }

func Same(a []int) int { n := 0; for _, x := range a { for _, y := range a { n += x * y } }; return n } // nomos-disable-line ALG001

// nomos-disable-next-line CC001
func OtherRule(a []int) int { n := 0; for _, x := range a { for _, y := range a { n += x * y } }; return n }

func Reasoned(a []int) int { n := 0; for _, x := range a { for _, y := range a { n += x * y } }; return n } // nomos-disable-line alg001, CC003 -- input is bounded
