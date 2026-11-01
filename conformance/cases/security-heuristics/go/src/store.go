package sec

import "fmt"

var password = "hunter22"
var title = "hunter22"
var awsKey = "AKIAABCDEFGHIJKLMNOP"

func Query(name string) string {
	return "SELECT id FROM users WHERE name = '" + name + "'"
}

func Fixed() string {
	return "SELECT id FROM users"
}

func Formatted(id string) string {
	return fmt.Sprintf("DELETE FROM users WHERE id = %s", id)
}
