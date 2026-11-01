// Package analyzer implements the Nomos protocol for Go with the standard library only:
// go/parser for syntax, go/types for symbols. Formulas follow spec/metrics.md.
package analyzer

import (
	"go/ast"
	"go/importer"
	"go/parser"
	"go/scanner"
	"go/token"
	"go/types"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Place is a source range; the file is relative to the root with forward slashes.
type Place struct {
	File                                       string
	StartLine, StartColumn, EndLine, EndColumn int
}

// Token is a lexical token of a file; auto-inserted semicolons and comments are not tokens.
type Token struct {
	Line int
	Tok  token.Token
	Text string
}

// File is one source file.
type File struct {
	Path        string
	Lines, Loc  int
	Tokens      []Token
	Directives  *directives
	ImportLines map[int]bool
	AST         *ast.File
	Module      *Module
	Broken      bool
}

// Module is a Go package (D-038).
type Module struct {
	ID        string
	Name      string
	Dir       string
	Files     []*File
	Types     []*Type
	Functions []*Function // free functions
	Globals   []*Global
	Package   *types.Package
	Info      *types.Info
	Imports   map[string]Place
	Syntax    []*ast.File
	checking  bool
}

// Global is a package-level variable.
type Global struct {
	ID, Name string
	Place    Place
}

// Type is a package-level named type.
type Type struct {
	ID, Name    string
	Module      *Module
	Kind        string // struct, interface or defined
	Place       Place
	Spec        *ast.TypeSpec
	Fields      []*types.Var // own fields, embedded ones included
	FieldCount  int
	Embedded    []*ast.Field
	Methods     []*Function
	NestedCount int
}

// IsAbstract says whether the type counts toward abstractness.
func (t *Type) IsAbstract() bool { return t.Kind == "interface" }

// Function is a function, a method or an interface method; function literals belong to their owner.
type Function struct {
	ID, Name string
	Module   *Module
	Owner    *Type
	Place    Place
	Decl     *ast.FuncDecl // nil for an interface method
	Sig      *ast.FuncType
	Object   types.Object
	File     *File
}

// Body returns the body or nil.
func (f *Function) Body() *ast.BlockStmt {
	if f.Decl == nil {
		return nil
	}
	return f.Decl.Body
}

// Unit returns the id of the graph unit the function belongs to: its type, or itself.
func (f *Function) Unit() string {
	if f.Owner != nil {
		return f.Owner.ID
	}
	return f.ID
}

// Project is everything loaded from a root.
type Project struct {
	Root      string
	Fset      *token.FileSet
	Files     []*File
	Modules   []*Module
	Types     map[string]*Type
	Functions map[string]*Function
	ByObject  map[types.Object]*Function
	FieldOwn  map[*types.Var]*Type
	Semantic  bool
	byPath    map[string]*Module
	std       types.ImporterFrom
}

// AllFunctions lists every function in ordinal id order.
func (p *Project) AllFunctions() []*Function {
	list := make([]*Function, 0, len(p.Functions))
	for _, f := range p.Functions {
		list = append(list, f)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	return list
}

// AllTypes lists every type in ordinal id order.
func (p *Project) AllTypes() []*Type {
	list := make([]*Type, 0, len(p.Types))
	for _, t := range p.Types {
		list = append(list, t)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	return list
}

var modulePathLine = regexp.MustCompile(`(?m)^module\s+(\S+)`)

func modulePath(root string) string {
	if text, err := os.ReadFile(filepath.Join(root, "go.mod")); err == nil {
		if m := modulePathLine.FindSubmatch(text); m != nil {
			return strings.Trim(string(m[1]), `"`)
		}
	}
	return ""
}

func globMatches(pattern, value string) bool {
	expression := regexp.QuoteMeta(pattern)
	expression = strings.ReplaceAll(expression, `\*\*/`, `(.*/)?`)
	expression = strings.ReplaceAll(expression, `\*\*`, `.*`)
	expression = strings.ReplaceAll(expression, `\*`, `[^/]*`)
	matched, err := regexp.MatchString("^"+expression+"$", value)
	return err == nil && matched
}

func anyGlob(patterns []string, value string) bool {
	for _, p := range patterns {
		if globMatches(p, value) {
			return true
		}
	}
	return false
}

// Load parses and type-checks the Go files under root. Test files, vendor and testdata are not the analyzed program.
func Load(root string, include, exclude []string) (*Project, error) {
	p := &Project{
		Root: root, Fset: token.NewFileSet(), Types: map[string]*Type{}, Functions: map[string]*Function{},
		ByObject: map[types.Object]*Function{}, FieldOwn: map[*types.Var]*Type{}, Semantic: true, byPath: map[string]*Module{},
	}
	p.std, _ = importer.ForCompiler(p.Fset, "source", nil).(types.ImporterFrom)
	var paths []string
	err := filepath.WalkDir(root, func(file string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		name := entry.Name()
		if entry.IsDir() {
			if file != root && (name == "vendor" || name == "testdata" || name == "node_modules" || strings.HasPrefix(name, ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(name, ".go") && !strings.HasSuffix(name, "_test.go") {
			paths = append(paths, file)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(paths)
	for _, file := range paths {
		rel, err := filepath.Rel(root, file)
		if err != nil {
			return nil, err
		}
		rel = filepath.ToSlash(rel)
		if (len(include) > 0 && !anyGlob(include, rel)) || anyGlob(exclude, rel) {
			continue
		}
		if err := p.addFile(file, rel); err != nil {
			return nil, err
		}
	}
	sort.Slice(p.Files, func(i, j int) bool { return p.Files[i].Path < p.Files[j].Path })
	sort.Slice(p.Modules, func(i, j int) bool { return p.Modules[i].ID < p.Modules[j].ID })
	for _, m := range p.Modules {
		p.check(m)
	}
	for _, m := range p.Modules {
		p.declare(m)
	}
	return p, nil
}

// moduleOf finds the nearest go.mod at or above a directory inside the root: a repository may hold several Go modules.
func (p *Project) moduleOf(dir string) (base, baseDir string) {
	for current := dir; ; current = path.Dir(current) {
		if found := modulePath(filepath.Join(p.Root, filepath.FromSlash(current))); found != "" {
			return found, current
		}
		if current == "." {
			return "", "."
		}
	}
}

func (p *Project) addFile(file, rel string) error {
	source, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	f := &File{Path: rel, ImportLines: map[int]bool{}}
	f.Lines = strings.Count(string(source), "\n")
	if len(source) > 0 && source[len(source)-1] != '\n' {
		f.Lines++
	}
	f.Tokens, f.Directives = tokenize(source)
	seen := map[int]bool{}
	for _, t := range f.Tokens {
		seen[t.Line] = true
	}
	f.Loc = len(seen)
	tree, parseErr := parser.ParseFile(p.Fset, file, source, parser.SkipObjectResolution|parser.AllErrors)
	f.Broken = parseErr != nil
	p.Files = append(p.Files, f)
	if tree == nil || tree.Name == nil || tree.Name.Name == "" || tree.Name.Name == "_" {
		return nil
	}
	f.AST = tree
	for _, decl := range tree.Decls {
		if g, ok := decl.(*ast.GenDecl); ok && g.Tok == token.IMPORT {
			for line := p.Fset.Position(g.Pos()).Line; line <= p.Fset.Position(g.End()).Line; line++ {
				f.ImportLines[line] = true
			}
		}
	}
	f.ImportLines[p.Fset.Position(tree.Package).Line] = true
	dir := path.Dir(rel)
	base, baseDir := p.moduleOf(dir)
	inner := strings.TrimPrefix(strings.TrimPrefix(dir, baseDir), "/")
	id := base
	switch {
	case inner != "." && inner != "" && base != "":
		id = base + "/" + inner
	case inner != "." && inner != "":
		id = inner
	case base == "":
		id = tree.Name.Name
	}
	m := p.byPath[id]
	if m == nil {
		m = &Module{ID: id, Name: tree.Name.Name, Dir: dir, Imports: map[string]Place{}}
		p.byPath[id] = m
		p.Modules = append(p.Modules, m)
	}
	f.Module = m
	m.Files = append(m.Files, f)
	m.Syntax = append(m.Syntax, tree)
	return nil
}

func tokenize(source []byte) ([]Token, *directives) {
	var s scanner.Scanner
	set := token.NewFileSet()
	file := set.AddFile("", set.Base(), len(source))
	s.Init(file, source, func(token.Position, string) {}, scanner.ScanComments)
	var result []Token
	found := &directives{lines: map[int][]string{}}
	for {
		pos, tok, lit := s.Scan()
		if tok == token.EOF {
			return result, found
		}
		if tok == token.COMMENT {
			line := set.Position(pos).Line
			found.add(lit, line, line+strings.Count(lit, "\n"))
			continue
		}
		if tok == token.SEMICOLON && lit == "\n" {
			continue
		}
		text := lit
		if text == "" {
			text = tok.String()
		}
		result = append(result, Token{Line: set.Position(pos).Line, Tok: tok, Text: text})
	}
}

// Import satisfies types.Importer: project packages from the root, everything else from source.
func (p *Project) Import(importPath string) (*types.Package, error) {
	return p.ImportFrom(importPath, "", 0)
}

// ImportFrom satisfies types.ImporterFrom.
func (p *Project) ImportFrom(importPath, dir string, mode types.ImportMode) (*types.Package, error) {
	if m := p.byPath[importPath]; m != nil {
		return p.check(m), nil
	}
	pkg, err := p.std.ImportFrom(importPath, dir, mode)
	if err != nil {
		if isStandard(importPath) {
			p.Semantic = false
		}
		return nil, err
	}
	return pkg, nil
}

func isStandard(importPath string) bool {
	return !strings.Contains(strings.SplitN(importPath, "/", 2)[0], ".")
}

func (p *Project) check(m *Module) *types.Package {
	if m.Package != nil || m.checking {
		return m.Package
	}
	m.checking = true
	m.Info = &types.Info{
		Defs: map[*ast.Ident]types.Object{}, Uses: map[*ast.Ident]types.Object{}, Types: map[ast.Expr]types.TypeAndValue{},
		Selections: map[*ast.SelectorExpr]*types.Selection{}, Instances: map[*ast.Ident]types.Instance{},
	}
	// Unresolved symbols are expected (no third-party sources); facts work by names where they can.
	config := types.Config{Importer: p, Error: func(error) {}, DisableUnusedImportCheck: true}
	m.Package, _ = config.Check(m.ID, p.Fset, m.Syntax, m.Info)
	m.checking = false
	return m.Package
}

func (p *Project) place(from, to token.Pos) Place {
	a, b := p.Fset.Position(from), p.Fset.Position(to)
	rel, err := filepath.Rel(p.Root, a.Filename)
	if err != nil {
		rel = a.Filename
	}
	return Place{filepath.ToSlash(rel), a.Line, a.Column, b.Line, b.Column}
}

func (p *Project) fileOf(m *Module, tree *ast.File) *File {
	for _, f := range m.Files {
		if f.AST == tree {
			return f
		}
	}
	return nil
}

// declare builds types, functions and globals of a module from its syntax.
func (p *Project) declare(m *Module) {
	var methods []*ast.FuncDecl
	owners := map[*ast.FuncDecl]*File{}
	inits := 0
	for _, tree := range m.Syntax {
		f := p.fileOf(m, tree)
		for _, spec := range tree.Imports {
			target := strings.Trim(spec.Path.Value, `"`)
			if _, known := m.Imports[target]; !known {
				m.Imports[target] = p.place(spec.Pos(), spec.End())
			}
		}
		for _, decl := range tree.Decls {
			switch d := decl.(type) {
			case *ast.GenDecl:
				p.declareGeneric(m, d)
			case *ast.FuncDecl:
				if d.Recv != nil {
					methods = append(methods, d)
					owners[d] = f
					continue
				}
				name := d.Name.Name
				id := m.ID + "." + name
				if name == "init" || name == "_" {
					inits++
					id = m.ID + "." + name + "#" + itoa(inits)
				}
				fn := &Function{ID: id, Name: name, Module: m, Place: p.place(d.Pos(), d.End()), Decl: d, Sig: d.Type, Object: m.Info.Defs[d.Name], File: f}
				m.Functions = append(m.Functions, fn)
				p.register(fn)
			}
		}
	}
	for _, d := range methods {
		owner := p.Types[m.ID+"."+receiverName(d)]
		if owner == nil {
			continue
		}
		fn := &Function{ID: owner.ID + "." + d.Name.Name, Name: d.Name.Name, Module: m, Owner: owner, Place: p.place(d.Pos(), d.End()), Decl: d, Sig: d.Type, Object: m.Info.Defs[d.Name], File: owners[d]}
		owner.Methods = append(owner.Methods, fn)
		p.register(fn)
	}
}

func (p *Project) register(fn *Function) {
	p.Functions[fn.ID] = fn
	if fn.Object != nil {
		p.ByObject[fn.Object] = fn
	}
}

func itoa(n int) string {
	if n < 10 {
		return string(rune('0' + n))
	}
	return itoa(n/10) + string(rune('0'+n%10))
}

func receiverName(d *ast.FuncDecl) string {
	expression := d.Recv.List[0].Type
	for {
		switch e := expression.(type) {
		case *ast.StarExpr:
			expression = e.X
		case *ast.IndexExpr:
			expression = e.X
		case *ast.IndexListExpr:
			expression = e.X
		case *ast.Ident:
			return e.Name
		default:
			return ""
		}
	}
}

func (p *Project) declareGeneric(m *Module, d *ast.GenDecl) {
	for _, spec := range d.Specs {
		switch s := spec.(type) {
		case *ast.ValueSpec:
			if d.Tok != token.VAR {
				continue
			}
			for _, name := range s.Names {
				if name.Name != "_" {
					m.Globals = append(m.Globals, &Global{ID: m.ID + "." + name.Name, Name: name.Name, Place: p.place(name.Pos(), name.End())})
				}
			}
		case *ast.TypeSpec:
			start := s.Pos()
			if !d.Lparen.IsValid() {
				start = d.Pos()
			}
			t := &Type{ID: m.ID + "." + s.Name.Name, Name: s.Name.Name, Module: m, Kind: "defined", Spec: s, Place: p.place(start, s.End())}
			switch body := s.Type.(type) {
			case *ast.StructType:
				t.Kind = "struct"
				p.declareStruct(m, t, body)
			case *ast.InterfaceType:
				t.Kind = "interface"
				p.declareInterface(m, t, body)
			}
			m.Types = append(m.Types, t)
			p.Types[t.ID] = t
		}
	}
}

func (p *Project) declareStruct(m *Module, t *Type, body *ast.StructType) {
	for _, field := range body.Fields.List {
		count := len(field.Names)
		if count == 0 {
			count = 1
			t.Embedded = append(t.Embedded, field)
		}
		t.FieldCount += count
		for _, name := range field.Names {
			if v, ok := m.Info.Defs[name].(*types.Var); ok {
				t.Fields = append(t.Fields, v)
				p.FieldOwn[v] = t
			}
		}
	}
}

func (p *Project) declareInterface(m *Module, t *Type, body *ast.InterfaceType) {
	for _, field := range body.Methods.List {
		sig, ok := field.Type.(*ast.FuncType)
		if !ok || len(field.Names) == 0 {
			t.Embedded = append(t.Embedded, field)
			continue
		}
		name := field.Names[0]
		fn := &Function{ID: t.ID + "." + name.Name, Name: name.Name, Module: m, Owner: t, Place: p.place(field.Pos(), field.End()), Sig: sig, Object: m.Info.Defs[name]}
		t.Methods = append(t.Methods, fn)
		p.register(fn)
	}
}
