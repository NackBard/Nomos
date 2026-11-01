package oc

type Data struct {
	Value int
	Other int
}

type Mixed struct {
	a      int
	b      int
	Source *Data
}

func (m *Mixed) IncA() {
	m.a++
}

func (m *Mixed) ReadA() int {
	return m.a
}

func (m *Mixed) IncB() {
	m.b++
}

func (m *Mixed) Peek() int {
	return m.Source.Value + m.Source.Other
}

type Derived struct {
	Mixed
}
