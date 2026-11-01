package metrics

func Straight(a int) int {
	return a + 1
}

// A comment line: it counts toward the lines of the file but not toward loc.
func Branches(a, b int) int {
	if a > 0 && b > 0 {
		return 1
	} else if a < 0 || b < 0 {
		return -1
	}

	return 0
}

func Loops(items []int, limit int) int {
	total := 0
	for _, item := range items {
		for i := 0; i < limit; i++ {
			if item > i {
				total += item
			}
		}
	}

	return total
}

func Switches(kind int, text string) string {
	switch kind {
	case 1:
		return "one"
	case 2:
		return "two"
	default:
		return text
	}
}
