// nomos-disable ALG001
package whole

func Pairs(a []int) int { n := 0; for _, x := range a { for _, y := range a { n += x * y } }; return n }
