package oc

import "strings"

type Fail struct {
	strings.Builder
}

type DeepFail struct {
	Fail
}
