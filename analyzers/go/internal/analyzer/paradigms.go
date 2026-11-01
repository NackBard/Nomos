package analyzer

import (
	"go/ast"
	"go/token"
	"go/types"
	"sort"
)

// Evidence is a sign of a paradigm in a module (spec/paradigms.md).
type Evidence struct {
	Paradigm    string   `json:"paradigm"`
	Kind        string   `json:"kind"`
	Count       int      `json:"count"`
	Description string   `json:"description"`
	Examples    []string `json:"examples"`
}

var activating = set("oop.classes", "str.free-functions", "str.control-flow", "fp.higher-order", "fp.pure-functions")

// ActiveParadigms follows the activation column of spec/paradigms.md.
func ActiveParadigms(evidence []Evidence) []string {
	active := map[string]bool{}
	for _, e := range evidence {
		if activating[e.Kind] {
			active[e.Paradigm] = true
		}
	}
	return sortedKeys(active)
}

func addEvidence(list *[]Evidence, paradigm, kind, description string, ids []string, count int) {
	if count == 0 {
		return
	}
	unique := map[string]bool{}
	for _, id := range ids {
		unique[id] = true
	}
	examples := sortedKeys(unique)
	if len(examples) > 5 {
		examples = examples[:5]
	}
	*list = append(*list, Evidence{paradigm, kind, count, description, examples})
}

func moduleFunctions(m *Module) []*Function {
	functions := append([]*Function{}, m.Functions...)
	for _, t := range m.Types {
		functions = append(functions, t.Methods...)
	}
	return functions
}

// CollectEvidence gathers the signs of one module. A Go struct stands for a class; fields of Go are always mutable,
// so fp.immutable-types has no carrier in the language and is never reported.
func (p *Project) CollectEvidence(m *Module, pure map[*Function]bool) []Evidence {
	var result []Evidence
	var classes, mutable, inheriting, abstract []string
	for _, t := range m.Types {
		if t.Kind == "struct" {
			if t.FieldCount+len(t.Methods) > 0 {
				classes = append(classes, t.ID)
			}
			if t.FieldCount > 0 {
				mutable = append(mutable, t.ID)
			}
			for _, field := range t.Embedded {
				if id := p.embeddedID(t, field); id != "" && p.Types[id].Kind == "struct" {
					inheriting = append(inheriting, t.ID)
					break
				}
			}
		}
		if t.IsAbstract() {
			abstract = append(abstract, t.ID)
		}
	}
	addEvidence(&result, "oop", "oop.classes", "classes with methods or fields", classes, len(classes))
	addEvidence(&result, "oop", "oop.mutable-state-classes", "classes with mutable instance state", mutable, len(mutable))
	addEvidence(&result, "oop", "oop.inheritance", "project types inheriting project types", inheriting, len(inheriting))
	addEvidence(&result, "oop", "oop.abstractions", "interfaces and abstract classes", abstract, len(abstract))

	functions := moduleFunctions(m)
	var free, flow, higher, pureIDs, lambdaOwners []string
	lambdas := 0
	for _, f := range m.Functions {
		free = append(free, f.ID)
	}
	for _, f := range functions {
		if hasControlFlow(f) {
			flow = append(flow, f.ID)
		}
		if takesFunctions(f) {
			higher = append(higher, f.ID)
		}
		if pure[f] {
			pureIDs = append(pureIDs, f.ID)
		}
		inspectBody(f, func(n ast.Node) bool {
			if call, ok := n.(*ast.CallExpr); ok {
				for _, argument := range call.Args {
					if _, literal := argument.(*ast.FuncLit); literal {
						lambdas++
						lambdaOwners = append(lambdaOwners, f.ID)
					}
				}
			}
			return true
		})
	}
	var globals []string
	for _, g := range m.Globals {
		globals = append(globals, g.ID)
	}
	addEvidence(&result, "structural", "str.free-functions", "functions outside types", free, len(free))
	addEvidence(&result, "structural", "str.control-flow", "functions with branches or loops", flow, len(flow))
	addEvidence(&result, "structural", "str.global-state", "module-level variables and static mutable state", globals, len(globals))
	addEvidence(&result, "functional", "fp.lambdas", "lambdas passed as arguments", lambdaOwners, lambdas)
	addEvidence(&result, "functional", "fp.higher-order", "functions taking or returning functions", higher, len(higher))
	addEvidence(&result, "functional", "fp.pure-functions", "functions that provably have no effects (conservative)", pureIDs, len(pureIDs))
	sort.Slice(result, func(i, j int) bool { return result[i].Kind < result[j].Kind })
	return result
}

func hasControlFlow(f *Function) bool {
	found := false
	inspectBody(f, func(n ast.Node) bool {
		switch n.(type) {
		case *ast.IfStmt, *ast.ForStmt, *ast.RangeStmt, *ast.SwitchStmt, *ast.TypeSwitchStmt, *ast.SelectStmt:
			found = true
		}
		return !found
	})
	return found
}

func takesFunctions(f *Function) bool {
	for _, list := range []*ast.FieldList{f.Sig.Params, f.Sig.Results} {
		if list == nil {
			continue
		}
		for _, field := range list.List {
			if _, ok := field.Type.(*ast.FuncType); ok {
				return true
			}
		}
	}
	return false
}

// PureFunctions applies the conservative definition of spec/paradigms.md as a greatest fixed point.
func (p *Project) PureFunctions() map[*Function]bool {
	pure := map[*Function]bool{}
	for _, f := range p.Functions {
		if f.Body() != nil && p.locallyPure(f) {
			pure[f] = true
		}
	}
	for changed := true; changed; {
		changed = false
		for f := range pure {
			if !p.callsOnlyPure(f, pure) {
				delete(pure, f)
				changed = true
			}
		}
	}
	return pure
}

var pureBuiltins = set("len", "cap", "min", "max")

func (p *Project) callsOnlyPure(f *Function, pure map[*Function]bool) bool {
	ok := true
	inspectBody(f, func(n ast.Node) bool {
		call, isCall := n.(*ast.CallExpr)
		if !isCall {
			return ok
		}
		info := f.Module.Info
		if tv, known := info.Types[call.Fun]; known && tv.IsType() {
			return ok
		}
		if id, isIdent := call.Fun.(*ast.Ident); isIdent {
			if _, builtin := info.Uses[id].(*types.Builtin); builtin {
				ok = ok && pureBuiltins[id.Name]
				return ok
			}
		}
		if pkg, _ := externalCall(f.Module, call); pkg == "math" || pkg == "strings" {
			return ok
		}
		target := p.callee(f.Module, call)
		ok = ok && target != nil && pure[target]
		return ok
	})
	return ok
}

func (p *Project) locallyPure(f *Function) bool {
	info := f.Module.Info
	ok := true
	own := func(x ast.Expr) bool {
		id, isIdent := x.(*ast.Ident)
		if !isIdent {
			return false
		}
		if id.Name == "_" {
			return true
		}
		v, isVar := info.ObjectOf(id).(*types.Var)
		return isVar && !isGlobal(v)
	}
	inspectBody(f, func(n ast.Node) bool {
		switch node := n.(type) {
		case *ast.AssignStmt:
			for _, target := range node.Lhs {
				ok = ok && own(target)
			}
		case *ast.IncDecStmt:
			ok = ok && own(node.X)
		case *ast.UnaryExpr:
			ok = ok && node.Op != token.ARROW
		case *ast.GoStmt, *ast.DeferStmt, *ast.SendStmt, *ast.FuncLit, *ast.SelectStmt, *ast.BadExpr, *ast.BadStmt:
			ok = false
		case *ast.Ident:
			if v, isVar := info.Uses[node].(*types.Var); isVar && isGlobal(v) {
				ok = false
			}
		}
		return ok
	})
	return ok
}

func isGlobal(v *types.Var) bool {
	return v.Pkg() != nil && v.Parent() == v.Pkg().Scope()
}
