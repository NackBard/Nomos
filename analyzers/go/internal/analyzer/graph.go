package analyzer

import (
	"go/ast"
	"go/token"
	"go/types"
	"sort"
	"strings"
)

// Edge is one occurrence of a dependency between units, or an import between modules.
type Edge struct {
	From, To, Kind string
	External       bool
	Stdlib         bool
	ToType         bool
	Place          Place
}

func importedPackage(m *Module, id *ast.Ident) string {
	if name, ok := m.Info.Uses[id].(*types.PkgName); ok {
		return name.Imported().Path()
	}
	return ""
}

func (p *Project) unitID(o types.Object) (id string, external, isType bool) {
	if o == nil || o.Pkg() == nil {
		return "", false, false
	}
	switch obj := o.(type) {
	case *types.TypeName:
		if obj.Parent() != obj.Pkg().Scope() {
			return "", false, false
		}
		id = obj.Pkg().Path() + "." + obj.Name()
		return id, p.Types[id] == nil, true
	case *types.Func:
		obj = obj.Origin()
		signature, _ := obj.Type().(*types.Signature)
		if signature != nil && signature.Recv() != nil {
			receiver := signature.Recv().Type()
			if pointer, ok := receiver.(*types.Pointer); ok {
				receiver = pointer.Elem()
			}
			if named, ok := types.Unalias(receiver).(*types.Named); ok && named.Obj().Pkg() != nil {
				id = named.Obj().Pkg().Path() + "." + named.Obj().Name()
				return id, p.Types[id] == nil, true
			}
			return "", false, false
		}
		if f := p.ByObject[obj]; f != nil {
			return f.ID, false, false
		}
		return obj.Pkg().Path() + "." + obj.Name(), true, false
	}
	return "", false, false
}

// Edges collects dependency occurrences by spec/metrics.md: rolled up to units, self-loops dropped.
func (p *Project) Edges() []Edge {
	var edges []Edge
	add := func(from string, m *Module, o types.Object, kind string, pos, end token.Pos) {
		to, external, isType := p.unitID(o)
		if to == "" || to == from {
			return
		}
		edges = append(edges, Edge{From: from, To: to, Kind: kind, External: external, Stdlib: external && isStandard(o.Pkg().Path()), ToType: isType, Place: p.place(pos, end)})
	}
	walk := func(from string, m *Module, root ast.Node) {
		calls := map[*ast.Ident]bool{}
		creations := map[*ast.Ident]bool{}
		mark := func(x ast.Expr, target map[*ast.Ident]bool) {
			switch e := x.(type) {
			case *ast.Ident:
				target[e] = true
			case *ast.SelectorExpr:
				target[e.Sel] = true
			case *ast.IndexExpr:
				if id, ok := e.X.(*ast.Ident); ok {
					target[id] = true
				}
			}
		}
		ast.Inspect(root, func(n ast.Node) bool {
			switch node := n.(type) {
			case *ast.CallExpr:
				mark(node.Fun, calls)
				if id, ok := node.Fun.(*ast.Ident); ok && id.Name == "new" && len(node.Args) == 1 {
					mark(node.Args[0], creations)
				}
			case *ast.CompositeLit:
				if node.Type != nil {
					mark(node.Type, creations)
				}
			}
			return true
		})
		ast.Inspect(root, func(n ast.Node) bool {
			id, ok := n.(*ast.Ident)
			if !ok {
				return true
			}
			switch o := m.Info.Uses[id].(type) {
			case *types.TypeName:
				kind := "type-ref"
				if creations[id] {
					kind = "call"
				}
				add(from, m, o, kind, id.Pos(), id.End())
			case *types.Func:
				kind := "type-ref"
				if calls[id] {
					kind = "call"
				}
				add(from, m, o, kind, id.Pos(), id.End())
			case *types.Var:
				if owner := p.FieldOwn[o]; owner != nil && owner.ID != from {
					edges = append(edges, Edge{From: from, To: owner.ID, Kind: "type-ref", ToType: true, Place: p.place(id.Pos(), id.End())})
				}
			}
			return true
		})
	}
	for _, m := range p.Modules {
		for target, place := range m.Imports {
			target := target
			_, known := p.byPath[target]
			edges = append(edges, Edge{From: m.ID, To: target, Kind: "import", External: !known, Stdlib: !known && isStandard(target), Place: place})
		}
		for _, t := range m.Types {
			embedded := map[ast.Expr]bool{}
			for _, field := range t.Embedded {
				embedded[field.Type] = true
				expression := field.Type
				if star, ok := expression.(*ast.StarExpr); ok {
					expression = star.X
				}
				var id *ast.Ident
				switch e := expression.(type) {
				case *ast.Ident:
					id = e
				case *ast.SelectorExpr:
					id = e.Sel
				}
				if id != nil {
					add(t.ID, m, m.Info.Uses[id], "inheritance", id.Pos(), id.End())
				}
			}
			ast.Inspect(t.Spec.Type, func(n ast.Node) bool {
				if field, ok := n.(*ast.Field); ok && embedded[field.Type] {
					return false
				}
				if id, ok := n.(*ast.Ident); ok {
					add(t.ID, m, m.Info.Uses[id], "type-ref", id.Pos(), id.End())
				}
				return true
			})
			for _, fn := range t.Methods {
				if fn.Decl == nil {
					continue
				}
				walk(t.ID, m, fn.Decl.Type)
				if fn.Decl.Body != nil {
					walk(t.ID, m, fn.Decl.Body)
				}
			}
		}
		for _, fn := range m.Functions {
			walk(fn.ID, m, fn.Decl.Type)
			if fn.Decl.Body != nil {
				walk(fn.ID, m, fn.Decl.Body)
			}
		}
	}
	return edges
}

// Graph is a directed graph over string keys.
type Graph struct {
	Next, Prev map[string]map[string]bool
}

func newGraph() *Graph { return &Graph{map[string]map[string]bool{}, map[string]map[string]bool{}} }

func (g *Graph) node(n string) {
	if g.Next[n] == nil {
		g.Next[n] = map[string]bool{}
		g.Prev[n] = map[string]bool{}
	}
}

func (g *Graph) edge(a, b string) {
	g.node(a)
	g.node(b)
	g.Next[a][b] = true
	g.Prev[b][a] = true
}

// Graphs holds the unit graph, the module graph and what depends on them.
type Graphs struct {
	Units, Modules *Graph
	ModuleOf       map[string]*Module
	Radius         map[string]int
}

// Build builds both graphs from the project edges.
func (p *Project) Build(edges []Edge) *Graphs {
	g := &Graphs{Units: newGraph(), Modules: newGraph(), ModuleOf: map[string]*Module{}, Radius: map[string]int{}}
	for _, m := range p.Modules {
		g.Modules.node(m.ID)
		for _, t := range m.Types {
			g.ModuleOf[t.ID] = m
			g.Units.node(t.ID)
		}
		for _, f := range m.Functions {
			g.ModuleOf[f.ID] = m
			g.Units.node(f.ID)
		}
	}
	for _, e := range edges {
		if e.External {
			continue
		}
		if e.Kind == "import" {
			g.Modules.edge(e.From, e.To)
			continue
		}
		g.Units.edge(e.From, e.To)
		if a, b := g.ModuleOf[e.From], g.ModuleOf[e.To]; a != nil && b != nil && a != b {
			g.Modules.edge(a.ID, b.ID)
		}
	}
	for unit := range g.Units.Next {
		g.Radius[unit] = reach(g.Units, unit)
	}
	return g
}

func reach(g *Graph, start string) int {
	seen := map[string]bool{start: true}
	queue := []string{start}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		for dependent := range g.Prev[current] {
			if !seen[dependent] {
				seen[dependent] = true
				queue = append(queue, dependent)
			}
		}
	}
	return len(seen) - 1
}

// Components finds strongly connected components with two or more members (Tarjan), iteratively.
func Components(g *Graph) [][]string {
	index, low := map[string]int{}, map[string]int{}
	onStack := map[string]bool{}
	var stack []string
	var result [][]string
	counter := 0
	type frame struct {
		node string
		next []string
	}
	for _, start := range sortedKeys(g.Next) {
		if _, seen := index[start]; seen {
			continue
		}
		var work []*frame
		enter := func(n string) {
			index[n], low[n] = counter, counter
			counter++
			stack = append(stack, n)
			onStack[n] = true
			work = append(work, &frame{n, sortedKeys(g.Next[n])})
		}
		enter(start)
		for len(work) > 0 {
			top := work[len(work)-1]
			if len(top.next) > 0 {
				successor := top.next[0]
				top.next = top.next[1:]
				if _, seen := index[successor]; !seen {
					enter(successor)
				} else if onStack[successor] {
					low[top.node] = min(low[top.node], index[successor])
				}
				continue
			}
			work = work[:len(work)-1]
			if len(work) > 0 {
				parent := work[len(work)-1].node
				low[parent] = min(low[parent], low[top.node])
			}
			if low[top.node] != index[top.node] {
				continue
			}
			var component []string
			for {
				member := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				onStack[member] = false
				component = append(component, member)
				if member == top.node {
					break
				}
			}
			if len(component) > 1 {
				sort.Strings(component)
				result = append(result, component)
			}
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i][0] < result[j][0] })
	return result
}

func simpleName(id string) string {
	id = id[strings.LastIndex(id, "/")+1:]
	return id[strings.LastIndex(id, ".")+1:]
}
