package analyzer

import (
	"fmt"
	"go/ast"
	"go/constant"
	"go/token"
	"sort"
	"strings"
)

// Growth is n^Degree * (log n)^Log, or exponential (spec/metrics.md).
type Growth struct {
	Degree, Log            int
	Exponential, Uncertain bool
}

func (g Growth) times(o Growth) Growth {
	return Growth{g.Degree + o.Degree, g.Log + o.Log, g.Exponential || o.Exponential, g.Uncertain || o.Uncertain}
}

func (g Growth) or(o Growth) Growth {
	larger := g
	if o.Exponential != g.Exponential && o.Exponential || o.Exponential == g.Exponential && (o.Degree > g.Degree || o.Degree == g.Degree && o.Log > g.Log) {
		larger = o
	}
	larger.Uncertain = g.Uncertain || o.Uncertain
	return larger
}

// String renders the estimate for a message.
func (g Growth) String() string {
	if g.Exponential {
		return "O(2ⁿ)"
	}
	parts := []string{}
	switch g.Degree {
	case 0:
	case 1:
		parts = append(parts, "n")
	case 2:
		parts = append(parts, "n²")
	case 3:
		parts = append(parts, "n³")
	default:
		parts = append(parts, fmt.Sprintf("n^%d", g.Degree))
	}
	if g.Log == 1 {
		parts = append(parts, "log n")
	} else if g.Log > 1 {
		parts = append(parts, fmt.Sprintf("log^%d n", g.Log))
	}
	if len(parts) == 0 {
		return "O(1)"
	}
	return "O(" + strings.Join(parts, " ") + ")"
}

var (
	constantGrowth = Growth{}
	linearGrowth   = Growth{Degree: 1}
	logGrowth      = Growth{Log: 1}
)

// Linear standard library calls; the list belongs to the analyzer (spec/metrics.md).
var linearCalls = map[string]map[string]bool{
	"strings": set("Contains", "ContainsAny", "ContainsRune", "Count", "EqualFold", "Fields", "Index", "IndexAny", "IndexByte", "Join", "LastIndex", "Map", "Repeat", "Replace", "ReplaceAll", "Split", "ToLower", "ToUpper", "Trim", "TrimSpace"),
	"bytes":   set("Contains", "Count", "Equal", "Index", "Join", "Repeat", "ReplaceAll", "Split"),
	"slices":  set("Clone", "Compact", "Contains", "ContainsFunc", "Equal", "Index", "IndexFunc", "Max", "Min", "Reverse"),
	"maps":    set("Clone", "Copy", "Equal"),
}

var sortCalls = map[string]map[string]bool{
	"sort":   set("Float64s", "Ints", "Slice", "SliceStable", "Sort", "Stable", "Strings"),
	"slices": set("Sort", "SortFunc", "SortStableFunc"),
}

func set(items ...string) map[string]bool {
	result := map[string]bool{}
	for _, item := range items {
		result[item] = true
	}
	return result
}

// TimeEstimates estimates every function with a body in ordinal id order: mutual recursion is cut at the function
// still being estimated, so another order could give another value.
func (p *Project) TimeEstimates() map[string]Growth {
	e := &estimator{p: p, memo: map[*Function]Growth{}, active: map[*Function]bool{}, elements: map[string]bool{}}
	result := map[string]Growth{}
	for _, f := range p.AllFunctions() {
		if f.Body() != nil {
			result[f.ID] = e.estimate(f)
		}
	}
	return result
}

type estimator struct {
	p        *Project
	memo     map[*Function]Growth
	active   map[*Function]bool
	elements map[string]bool // names bound to one element of an enclosing iteration
	current  *Function
}

func (e *estimator) estimate(f *Function) Growth {
	if known, ok := e.memo[f]; ok {
		return known
	}
	if f.Body() == nil || e.active[f] {
		return constantGrowth
	}
	e.active[f] = true
	outerElements, outer := e.elements, e.current
	e.elements, e.current = map[string]bool{}, f
	work := e.cost(f.Body())
	growth := e.combine(f, work)
	e.elements, e.current = outerElements, outer
	delete(e.active, f)
	e.memo[f] = growth
	return growth
}

func (e *estimator) children(n ast.Node) Growth {
	total := constantGrowth
	ast.Inspect(n, func(c ast.Node) bool {
		if c == n || c == nil {
			return c == n
		}
		total = total.or(e.cost(c))
		return false
	})
	return total
}

func (e *estimator) cost(n ast.Node) Growth {
	switch node := n.(type) {
	case *ast.ForStmt:
		header := constantGrowth
		if node.Init != nil {
			header = e.cost(node.Init)
		}
		iteration := e.cost(node.Body)
		if node.Cond != nil {
			iteration = iteration.or(e.cost(node.Cond))
		}
		return header.or(e.forFactor(node).times(iteration))
	case *ast.RangeStmt:
		header := e.cost(node.X)
		added := ""
		if id, ok := node.Value.(*ast.Ident); ok && !e.elements[id.Name] {
			added = id.Name
			e.elements[added] = true
		}
		iteration := e.cost(node.Body)
		if added != "" {
			delete(e.elements, added)
		}
		factor := linearGrowth
		if e.isElementWalk(node.X) || isConstantRange(node.X) {
			factor = constantGrowth
		}
		return header.or(factor.times(iteration))
	case *ast.AssignStmt:
		if node.Tok == token.DEFINE && len(node.Lhs) == 1 && e.isElementWalk(node.Rhs[0]) {
			if id, ok := node.Lhs[0].(*ast.Ident); ok {
				e.elements[id.Name] = true
			}
		}
		return e.children(n)
	case *ast.CallExpr:
		return e.call(node)
	}
	return e.children(n)
}

func isConstantRange(x ast.Expr) bool {
	switch x.(type) {
	case *ast.CompositeLit, *ast.BasicLit:
		return true
	}
	return false
}

func (e *estimator) isElementWalk(x ast.Expr) bool {
	switch node := x.(type) {
	case *ast.Ident:
		return e.elements[node.Name]
	case *ast.SelectorExpr:
		return e.isElementWalk(node.X)
	case *ast.IndexExpr:
		return e.isElementWalk(node.X)
	case *ast.CallExpr:
		return e.isElementWalk(node.Fun)
	}
	return false
}

func (e *estimator) call(call *ast.CallExpr) Growth {
	parts, lambda := e.cost(call.Fun), constantGrowth
	var bound []string
	for _, argument := range call.Args {
		literal, ok := argument.(*ast.FuncLit)
		if !ok {
			parts = parts.or(e.cost(argument))
			continue
		}
		for _, field := range literal.Type.Params.List {
			for _, name := range field.Names {
				if !e.elements[name.Name] {
					e.elements[name.Name] = true
					bound = append(bound, name.Name)
				}
			}
		}
		lambda = lambda.or(e.cost(literal.Body))
	}
	for _, name := range bound {
		delete(e.elements, name)
	}
	module := e.current.Module
	if target := e.p.callee(module, call); target != nil {
		callee := e.estimate(target)
		if callee.Degree > 0 || callee.Log > 0 || callee.Exponential {
			callee.Uncertain = true
		}
		return parts.or(lambda).or(callee)
	}
	if pkg, name := externalCall(module, call); pkg != "" {
		if sortCalls[pkg][name] {
			return parts.or(Growth{Degree: 1, Log: 1})
		}
		if linearCalls[pkg][name] {
			return parts.or(linearGrowth.times(lambda))
		}
	}
	return parts.or(lambda)
}

func externalCall(m *Module, call *ast.CallExpr) (string, string) {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return "", ""
	}
	if id, ok := sel.X.(*ast.Ident); ok {
		if pkg := importedPackage(m, id); pkg != "" {
			return pkg, sel.Sel.Name
		}
	}
	return "", ""
}

func (p *Project) callee(m *Module, call *ast.CallExpr) *Function {
	var id *ast.Ident
	switch fun := call.Fun.(type) {
	case *ast.Ident:
		id = fun
	case *ast.SelectorExpr:
		id = fun.Sel
	default:
		return nil
	}
	return p.ByObject[originOf(m.Info.Uses[id])]
}

func dividesByTwo(n ast.Node) bool {
	found := false
	ast.Inspect(n, func(c ast.Node) bool {
		if b, ok := c.(*ast.BinaryExpr); ok && (b.Op == token.QUO || b.Op == token.SHR) {
			if literal, ok := b.Y.(*ast.BasicLit); ok && (literal.Value == "2" || literal.Value == "1") {
				found = true
			}
		}
		return !found
	})
	return found
}

func isHalvingStatement(s ast.Stmt) bool {
	assign, ok := s.(*ast.AssignStmt)
	if !ok {
		return false
	}
	switch assign.Tok {
	case token.QUO_ASSIGN, token.SHR_ASSIGN, token.MUL_ASSIGN, token.SHL_ASSIGN:
		return true
	}
	for _, value := range assign.Rhs {
		if dividesByTwo(value) {
			return true
		}
	}
	return false
}

func isLiteralNumber(x ast.Expr) bool {
	literal, ok := x.(*ast.BasicLit)
	return ok && literal.Kind == token.INT
}

func (e *estimator) forFactor(loop *ast.ForStmt) Growth {
	if loop.Post != nil && isHalvingStatement(loop.Post) {
		return logGrowth
	}
	if loop.Init != nil || loop.Post != nil {
		binary, ok := loop.Cond.(*ast.BinaryExpr)
		init, assign := loop.Init.(*ast.AssignStmt)
		if ok && assign && isLiteralNumber(binary.Y) && len(init.Rhs) == 1 && isLiteralNumber(init.Rhs[0]) {
			return constantGrowth
		}
		return linearGrowth
	}
	// A loop with a condition only is the while of the spec.
	halves := false
	ast.Inspect(loop.Body, func(c ast.Node) bool {
		if s, ok := c.(ast.Stmt); ok && isHalvingStatement(s) {
			halves = true
		}
		return !halves
	})
	growth := linearGrowth
	if halves {
		growth = logGrowth
	}
	growth.Uncertain = true
	return growth
}

func (p *Project) selfCalls(f *Function) []*ast.CallExpr {
	var calls []*ast.CallExpr
	inspectBody(f, func(n ast.Node) bool {
		if call, ok := n.(*ast.CallExpr); ok && p.callee(f.Module, call) == f {
			calls = append(calls, call)
		}
		return true
	})
	return calls
}

func (e *estimator) combine(f *Function, work Growth) Growth {
	self := e.p.selfCalls(f)
	if len(self) == 0 {
		return work
	}
	halfNames := map[string]bool{}
	memoized := false
	inspectBody(f, func(n ast.Node) bool {
		if assign, ok := n.(*ast.AssignStmt); ok {
			if len(assign.Rhs) == 1 && dividesByTwo(assign.Rhs[0]) {
				for _, target := range assign.Lhs {
					if id, ok := target.(*ast.Ident); ok {
						halfNames[id.Name] = true
					}
				}
			}
			// v, ok := table[key] is the Go form of a memo lookup.
			if len(assign.Lhs) == 2 && len(assign.Rhs) == 1 {
				if _, index := assign.Rhs[0].(*ast.IndexExpr); index {
					memoized = true
				}
			}
		}
		return true
	})
	halving, decrements := false, false
	for _, call := range self {
		for _, argument := range call.Args {
			ast.Inspect(argument, func(c ast.Node) bool {
				switch node := c.(type) {
				case *ast.Ident:
					halving = halving || halfNames[node.Name]
				case *ast.BinaryExpr:
					decrements = decrements || node.Op == token.SUB || node.Op == token.ADD
				}
				return true
			})
			halving = halving || dividesByTwo(argument)
		}
	}
	perPath := e.callsOnPath(f, f.Body())
	var recursion Growth
	switch {
	case perPath <= 1 && halving:
		recursion = logGrowth
	case perPath <= 1:
		recursion = linearGrowth
	case halving:
		recursion = linearGrowth
	case memoized || !decrements:
		recursion = linearGrowth
	default:
		recursion = Growth{Exponential: true}
	}
	var total Growth
	switch {
	case perPath > 1 && halving:
		total = work.or(linearGrowth).times(logGrowth)
	case !halving && !decrements:
		total = work.or(linearGrowth)
	default:
		total = recursion.times(work)
	}
	total.Uncertain = true
	return total
}

func canComplete(block *ast.BlockStmt) bool {
	if len(block.List) == 0 {
		return true
	}
	switch last := block.List[len(block.List)-1].(type) {
	case *ast.ReturnStmt:
		return false
	case *ast.ExprStmt:
		if call, ok := last.X.(*ast.CallExpr); ok {
			if id, ok := call.Fun.(*ast.Ident); ok && id.Name == "panic" {
				return false
			}
		}
	}
	return true
}

// callsOnPath counts self-calls on the worst path, so exclusive branches do not add up.
func (e *estimator) callsOnPath(f *Function, n ast.Node) int {
	if n == nil {
		return 0
	}
	switch node := n.(type) {
	case *ast.IfStmt:
		other := 0
		if node.Else != nil {
			other = e.callsOnPath(f, node.Else)
		}
		return e.callsOnPath(f, node.Cond) + max(e.callsOnPath(f, node.Body), other)
	case *ast.SwitchStmt:
		return e.worstClause(f, node.Body)
	case *ast.TypeSwitchStmt:
		return e.worstClause(f, node.Body)
	case *ast.SelectStmt:
		return e.worstClause(f, node.Body)
	case *ast.BlockStmt:
		return e.blockCalls(f, node.List)
	}
	count := 0
	if call, ok := n.(*ast.CallExpr); ok && e.p.callee(f.Module, call) == f {
		count = 1
	}
	ast.Inspect(n, func(c ast.Node) bool {
		if c == n || c == nil {
			return c == n
		}
		count += e.callsOnPath(f, c)
		return false
	})
	return count
}

func (e *estimator) worstClause(f *Function, body *ast.BlockStmt) int {
	worst := 0
	for _, clause := range body.List {
		worst = max(worst, e.callsOnPath(f, clause))
	}
	return worst
}

func (e *estimator) blockCalls(f *Function, list []ast.Stmt) int {
	if len(list) == 0 {
		return 0
	}
	if guard, ok := list[0].(*ast.IfStmt); ok && guard.Else == nil && !canComplete(guard.Body) {
		return e.callsOnPath(f, guard.Cond) + max(e.callsOnPath(f, guard.Body), e.blockCalls(f, list[1:]))
	}
	return e.callsOnPath(f, list[0]) + e.blockCalls(f, list[1:])
}

func constantString(m *Module, x ast.Expr) (string, bool) {
	if tv, ok := m.Info.Types[x]; ok && tv.Value != nil && tv.Value.Kind() == constant.String {
		return constant.StringVal(tv.Value), true
	}
	return "", false
}

func sortedSet(items map[string]bool) []string {
	list := make([]string, 0, len(items))
	for item := range items {
		list = append(list, item)
	}
	sort.Strings(list)
	return list
}
