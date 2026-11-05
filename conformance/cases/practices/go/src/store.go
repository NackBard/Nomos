package prac

var password = "hunter22"

func Find(name string) string {
	return "SELECT id FROM items WHERE name = '" + name + "'"
}

func Sum(a, b, c, d, e, f int) int {
	return a + b + c + d + e + f
}
