package analyzer

import (
	"go/ast"
	"go/token"
	"go/types"
	"math"
	"sort"
	"strings"
)

func inspectBody(f *Function, visit func(ast.Node) bool) {
	if body := f.Body(); body != nil {
		ast.Inspect(body, visit)
	}
}

// Cyclomatic follows spec/metrics.md: function literals count toward the enclosing function.
func Cyclomatic(f *Function) int {
	count := 1
	inspectBody(f, func(n ast.Node) bool {
		switch node := n.(type) {
		case *ast.IfStmt, *ast.ForStmt, *ast.RangeStmt:
			count++
		case *ast.CaseClause:
			count += len(node.List)
		case *ast.CommClause:
			if node.Comm != nil {
				count++
			}
		case *ast.BinaryExpr:
			if node.Op == token.LAND || node.Op == token.LOR {
				count++
			}
		}
		return true
	})
	return count
}

// MaxNesting counts enclosing if, switch, select and loop statements; else-if stays on the level of its if.
func MaxNesting(f *Function) int {
	body := f.Body()
	if body == nil {
		return 0
	}
	return nesting(body, 0)
}

func nesting(node ast.Node, depth int) int {
	deepest := depth
	var walk func(n ast.Node, d int)
	children := func(parent ast.Node, d int) {
		ast.Inspect(parent, func(c ast.Node) bool {
			if c == parent || c == nil {
				return c == parent
			}
			walk(c, d)
			return false
		})
	}
	walk = func(n ast.Node, d int) {
		if d > deepest {
			deepest = d
		}
		switch s := n.(type) {
		case *ast.IfStmt:
			walkIf(s, d, walk)
		case *ast.SwitchStmt, *ast.TypeSwitchStmt, *ast.SelectStmt, *ast.ForStmt, *ast.RangeStmt:
			children(n, d+1)
			if d+1 > deepest {
				deepest = d + 1
			}
		default:
			children(n, d)
		}
	}
	children(node, depth)
	return deepest
}

func walkIf(s *ast.IfStmt, d int, walk func(ast.Node, int)) {
	walk(s.Body, d+1)
	walk(s.Cond, d)
	switch e := s.Else.(type) {
	case *ast.IfStmt:
		walkIf(e, d, walk)
	case *ast.BlockStmt:
		walk(e, d+1)
	}
}

// ParameterCount counts declared parameters; the receiver is implicit.
func ParameterCount(sig *ast.FuncType) int {
	count := 0
	for _, field := range sig.Params.List {
		if len(field.Names) == 0 {
			count++
		}
		count += len(field.Names)
	}
	return count
}

func functionDepth(expression ast.Expr) int {
	depth := 0
	switch e := expression.(type) {
	case *ast.FuncType:
		return 1 + signatureDepth(e)
	case *ast.ArrayType:
		depth = functionDepth(e.Elt)
	case *ast.MapType:
		depth = max(functionDepth(e.Key), functionDepth(e.Value))
	case *ast.StarExpr:
		depth = functionDepth(e.X)
	case *ast.ChanType:
		depth = functionDepth(e.Value)
	case *ast.Ellipsis:
		depth = functionDepth(e.Elt)
	}
	return depth
}

func signatureDepth(sig *ast.FuncType) int {
	depth := 0
	lists := []*ast.FieldList{sig.Params, sig.Results}
	for _, list := range lists {
		if list == nil {
			continue
		}
		for _, field := range list.List {
			depth = max(depth, functionDepth(field.Type))
		}
	}
	return depth
}

// HofOrder is 1 plus the deepest nesting of function types in the signature.
func HofOrder(f *Function) int { return 1 + signatureDepth(f.Sig) }

// LambdaNesting is the deepest nesting of function literals.
func LambdaNesting(f *Function) int {
	if f.Body() == nil {
		return 0
	}
	var walk func(n ast.Node) int
	walk = func(n ast.Node) int {
		deepest := 0
		ast.Inspect(n, func(c ast.Node) bool {
			if c == n || c == nil {
				return c == n
			}
			if lit, ok := c.(*ast.FuncLit); ok {
				deepest = max(deepest, 1+walk(lit.Body))
				return false
			}
			return true
		})
		return deepest
	}
	return walk(f.Body())
}

// TestedTypes lists the distinct project types a function tests at run time: type switches and assertions.
func (p *Project) TestedTypes(f *Function) []string {
	seen := map[string]bool{}
	add := func(m *Module, expression ast.Expr) {
		if expression == nil {
			return
		}
		if t := m.Info.TypeOf(expression); t != nil {
			if id := p.projectTypeID(t); id != "" {
				seen[id] = true
			}
		}
	}
	inspectBody(f, func(n ast.Node) bool {
		switch node := n.(type) {
		case *ast.TypeAssertExpr:
			add(f.Module, node.Type)
		case *ast.TypeSwitchStmt:
			for _, clause := range node.Body.List {
				for _, expression := range clause.(*ast.CaseClause).List {
					add(f.Module, expression)
				}
			}
		}
		return true
	})
	return sortedKeys(seen)
}

func (p *Project) projectTypeID(t types.Type) string {
	if pointer, ok := t.(*types.Pointer); ok {
		t = pointer.Elem()
	}
	if named, ok := types.Unalias(t).(*types.Named); ok && named.Obj().Pkg() != nil {
		id := named.Obj().Pkg().Path() + "." + named.Obj().Name()
		if p.Types[id] != nil {
			return id
		}
	}
	return ""
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// AllocationDepth is the deepest loop nesting of a heap allocation.
func (p *Project) AllocationDepth(f *Function) int {
	deepest := 0
	p.walkLoops(f, func(n ast.Node, depth int) {
		if p.allocates(f, n) {
			deepest = max(deepest, depth)
		}
	})
	return deepest
}

func (p *Project) allocates(f *Function, n ast.Node) bool {
	switch node := n.(type) {
	case *ast.FuncLit:
		return true
	case *ast.UnaryExpr:
		_, composite := node.X.(*ast.CompositeLit)
		return node.Op == token.AND && composite
	case *ast.CompositeLit:
		t := f.Module.Info.TypeOf(node)
		if t == nil {
			return false
		}
		switch t.Underlying().(type) {
		case *types.Slice, *types.Map:
			return true
		}
	case *ast.CallExpr:
		if id, ok := node.Fun.(*ast.Ident); ok {
			return id.Name == "make" || id.Name == "new"
		}
	}
	return false
}

// walkLoops visits every node with the number of loops whose body holds it; loop headers that run once are outside.
func (p *Project) walkLoops(f *Function, visit func(ast.Node, int)) {
	body := f.Body()
	if body == nil {
		return
	}
	var walk func(n ast.Node, depth int)
	walk = func(n ast.Node, depth int) {
		ast.Inspect(n, func(c ast.Node) bool {
			if c == nil {
				return false
			}
			if c != n {
				switch loop := c.(type) {
				case *ast.ForStmt:
					visit(c, depth)
					if loop.Init != nil {
						walk(loop.Init, depth)
					}
					for _, part := range []ast.Node{nodeOf(loop.Cond), nodeOf(loop.Post), loop.Body} {
						if part != nil {
							walk(part, depth+1)
						}
					}
					return false
				case *ast.RangeStmt:
					visit(c, depth)
					walk(loop.X, depth)
					walk(loop.Body, depth+1)
					return false
				}
			}
			visit(c, depth)
			return true
		})
	}
	walk(body, 0)
}

func nodeOf[T ast.Node](value T) ast.Node {
	if any(value) == nil {
		return nil
	}
	return value
}

// SpaceDegree follows spec/metrics.md: growth by append, make with a non-literal size, direct recursion.
func (p *Project) SpaceDegree(f *Function) int {
	degree := 0
	p.walkLoops(f, func(n ast.Node, depth int) {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return
		}
		id, ok := call.Fun.(*ast.Ident)
		if !ok {
			return
		}
		switch id.Name {
		case "append":
			degree = max(degree, depth)
		case "make":
			sized := 0
			for _, argument := range call.Args[min(1, len(call.Args)):] {
				if _, literal := argument.(*ast.BasicLit); !literal {
					sized++
				}
			}
			if sized > 0 {
				degree = max(degree, min(sized, 1)+depth)
			}
		}
	})
	if len(p.selfCalls(f)) > 0 {
		degree = max(degree, 1)
	}
	return degree
}

// memberUse returns the fields of its own type a function touches and, by owner, the fields of other project structs.
func (p *Project) memberUse(f *Function) (own map[*types.Var]bool, foreign map[string]map[string]bool) {
	own, foreign = map[*types.Var]bool{}, map[string]map[string]bool{}
	inspectBody(f, func(n ast.Node) bool {
		sel, ok := n.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		field, ok := f.Module.Info.Uses[sel.Sel].(*types.Var)
		if !ok {
			return true
		}
		owner := p.FieldOwn[field]
		switch {
		case owner == nil:
		case owner == f.Owner:
			own[field] = true
		default:
			if foreign[owner.ID] == nil {
				foreign[owner.ID] = map[string]bool{}
			}
			foreign[owner.ID][field.Name()] = true
		}
		return true
	})
	return own, foreign
}

// MostUsedForeign returns the other type a method uses most fields of, by ordinal id on a tie.
func (p *Project) MostUsedForeign(f *Function) (string, []string) {
	_, foreign := p.memberUse(f)
	best := ""
	for _, id := range sortedKeys(foreign) {
		if best == "" || len(foreign[id]) > len(foreign[best]) {
			best = id
		}
	}
	if best == "" {
		return "", nil
	}
	return best, sortedKeys(foreign[best])
}

func isMethod(f *Function) bool { return f.Owner != nil && f.Body() != nil }

func structMethods(t *Type) []*Function {
	var list []*Function
	for _, m := range t.Methods {
		if m.Body() != nil {
			list = append(list, m)
		}
	}
	return list
}

// WMC sums the cyclomatic complexity of the methods.
func WMC(t *Type) int {
	total := 0
	for _, m := range t.Methods {
		total += Cyclomatic(m)
	}
	return total
}

// DIT is the longest chain of embedded types; an embedded type outside the project is one step.
func (p *Project) DIT(t *Type, seen map[string]bool) int {
	if seen == nil {
		seen = map[string]bool{t.ID: true}
	}
	deepest := 0
	for _, field := range t.Embedded {
		if base := t.Module.Info.TypeOf(field.Type); base != nil {
			if _, isInterface := base.Underlying().(*types.Interface); isInterface {
				continue
			}
		}
		depth := 1
		if id := p.embeddedID(t, field); id != "" && !seen[id] {
			next := map[string]bool{id: true}
			for k := range seen {
				next[k] = true
			}
			depth += p.DIT(p.Types[id], next)
		}
		deepest = max(deepest, depth)
	}
	return deepest
}

func (p *Project) embeddedID(t *Type, field *ast.Field) string {
	if resolved := t.Module.Info.TypeOf(field.Type); resolved != nil {
		return p.projectTypeID(resolved)
	}
	return ""
}

func calledMethods(p *Project, f *Function) map[*Function]bool {
	result := map[*Function]bool{}
	inspectBody(f, func(n ast.Node) bool {
		if sel, ok := n.(*ast.SelectorExpr); ok {
			if target := p.ByObject[originOf(f.Module.Info.Uses[sel.Sel])]; target != nil {
				result[target] = true
			}
		}
		return true
	})
	return result
}

func originOf(o types.Object) types.Object {
	if fn, ok := o.(*types.Func); ok {
		return fn.Origin()
	}
	return o
}

// LCOM4 counts connected components of methods: shared field or a call. Null below one method.
func (p *Project) LCOM4(t *Type) *float64 {
	methods := structMethods(t)
	if len(methods) == 0 {
		return nil
	}
	parent := make([]int, len(methods))
	for i := range parent {
		parent[i] = i
	}
	var find func(int) int
	find = func(i int) int {
		if parent[i] != i {
			parent[i] = find(parent[i])
		}
		return parent[i]
	}
	uses := make([]map[*types.Var]bool, len(methods))
	calls := make([]map[*Function]bool, len(methods))
	for i, m := range methods {
		uses[i], _ = p.memberUse(m)
		calls[i] = calledMethods(p, m)
	}
	for i := range methods {
		for j := i + 1; j < len(methods); j++ {
			if overlaps(uses[i], uses[j]) || calls[i][methods[j]] || calls[j][methods[i]] {
				parent[find(i)] = find(j)
			}
		}
	}
	roots := map[int]bool{}
	for i := range methods {
		roots[find(i)] = true
	}
	return number(float64(len(roots)))
}

func overlaps(a, b map[*types.Var]bool) bool {
	for k := range a {
		if b[k] {
			return true
		}
	}
	return false
}

// TCC is the share of pairs of methods using a common field. Go has no private methods: every method is visible.
func (p *Project) TCC(t *Type) *float64 {
	methods := structMethods(t)
	if len(methods) < 2 {
		return nil
	}
	uses := make([]map[*types.Var]bool, len(methods))
	for i, m := range methods {
		uses[i], _ = p.memberUse(m)
	}
	connected := 0
	for i := range uses {
		for j := i + 1; j < len(uses); j++ {
			if overlaps(uses[i], uses[j]) {
				connected++
			}
		}
	}
	return number(round(float64(connected)/(float64(len(uses)*(len(uses)-1))/2), 4))
}

// ATFD counts distinct fields of other project structs reached by the methods.
func (p *Project) ATFD(t *Type) int {
	seen := map[string]bool{}
	for _, m := range t.Methods {
		_, foreign := p.memberUse(m)
		for owner, fields := range foreign {
			for field := range fields {
				seen[owner+"."+field] = true
			}
		}
	}
	return len(seen)
}

var separators = map[token.Token]bool{
	token.LPAREN: true, token.RPAREN: true, token.LBRACE: true, token.RBRACE: true, token.LBRACK: true, token.RBRACK: true, token.SEMICOLON: true, token.COMMA: true,
}

// HalsteadVolume is N log2 n over the tokens of the lines of a function, without separators.
func HalsteadVolume(f *Function) *float64 {
	if f.File == nil {
		return nil
	}
	total := 0
	distinct := map[string]bool{}
	for _, t := range f.File.Tokens {
		if t.Line >= f.Place.StartLine && t.Line <= f.Place.EndLine && !separators[t.Tok] {
			total++
			distinct[t.Text] = true
		}
	}
	if len(distinct) < 2 {
		return nil
	}
	return number(float64(total) * math.Log2(float64(len(distinct))))
}

// MaintainabilityIndex follows spec/metrics.md.
func MaintainabilityIndex(f *Function) *float64 {
	volume := HalsteadVolume(f)
	lines := f.Place.EndLine - f.Place.StartLine + 1
	if volume == nil || lines == 0 {
		return nil
	}
	return number(math.Max(0, (171-5.2*math.Log(*volume)-0.23*float64(Cyclomatic(f))-16.2*math.Log(float64(lines)))*100/171))
}

func number(v float64) *float64 { return &v }

func round(v float64, digits int) float64 {
	scale := math.Pow10(digits)
	return math.Round(v*scale) / scale
}

func exported(name string) bool {
	return strings.ToUpper(name[:1]) == name[:1] && strings.ToLower(name[:1]) != name[:1]
}
