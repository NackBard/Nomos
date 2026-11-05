package analyzer

import (
	"go/ast"
	"go/types"
	"sort"
	"strings"
)

// Structure of types and functions for facts 1.3.0, as spec/structure.md defines it.

type factsMember struct {
	Name         string `json:"name"`
	Kind         string `json:"kind"`
	Visibility   string `json:"visibility"`
	TypeName     string `json:"typeName,omitempty"`
	Type         string `json:"type,omitempty"`
	IsCollection bool   `json:"isCollection,omitempty"`
	IsEmbedded   bool   `json:"isEmbedded,omitempty"`
}

type factsParameter struct {
	Name     string `json:"name"`
	TypeName string `json:"typeName,omitempty"`
}

func visibilityOf(name string) string {
	if exported(name) {
		return "public"
	}
	return "internal"
}

// typeParameters lists the names of the type parameters of a generic type.
func typeParameters(t *Type) []string {
	if t.Spec == nil || t.Spec.TypeParams == nil {
		return nil
	}
	var names []string
	for _, field := range t.Spec.TypeParams.List {
		for _, name := range field.Names {
			names = append(names, name.Name)
		}
	}
	return names
}

// members lists the fields of a struct in declaration order; an embedded field is named after its type.
func (p *Project) members(t *Type) []factsMember {
	body, ok := t.Spec.Type.(*ast.StructType)
	if !ok {
		return nil
	}
	var list []factsMember
	for _, field := range body.Fields.List {
		typeName := types.ExprString(field.Type)
		target, collection := p.memberTarget(t.Module.Info.TypeOf(field.Type))
		if len(field.Names) == 0 {
			name := embeddedName(field.Type)
			list = append(list, factsMember{Name: name, Kind: "field", Visibility: visibilityOf(name), TypeName: typeName, Type: target, IsCollection: collection, IsEmbedded: true})
			continue
		}
		for _, name := range field.Names {
			list = append(list, factsMember{Name: name.Name, Kind: "field", Visibility: visibilityOf(name.Name), TypeName: typeName, Type: target, IsCollection: collection})
		}
	}
	return list
}

// memberTarget is the project type a member is about: the element of a slice, array, map or channel, behind pointers.
func (p *Project) memberTarget(t types.Type) (string, bool) {
	if t == nil {
		return "", false
	}
	collection := false
	switch c := types.Unalias(t).(type) {
	case *types.Slice:
		t, collection = c.Elem(), true
	case *types.Array:
		t, collection = c.Elem(), true
	case *types.Map:
		t, collection = c.Elem(), true
	case *types.Chan:
		t, collection = c.Elem(), true
	}
	return p.projectTypeID(t), collection
}

func embeddedName(expression ast.Expr) string {
	for {
		switch e := expression.(type) {
		case *ast.StarExpr:
			expression = e.X
		case *ast.IndexExpr:
			expression = e.X
		case *ast.IndexListExpr:
			expression = e.X
		case *ast.SelectorExpr:
			return e.Sel.Name
		case *ast.Ident:
			return e.Name
		default:
			return types.ExprString(expression)
		}
	}
}

// signature gives the parameters and the result as written; the receiver is not a parameter.
func signature(sig *ast.FuncType) ([]factsParameter, string) {
	parameters := []factsParameter{}
	if sig == nil {
		return parameters, ""
	}
	for _, field := range sig.Params.List {
		typeName := types.ExprString(field.Type)
		if len(field.Names) == 0 {
			parameters = append(parameters, factsParameter{Name: "", TypeName: typeName})
		}
		for _, name := range field.Names {
			parameters = append(parameters, factsParameter{Name: name.Name, TypeName: typeName})
		}
	}
	if sig.Results == nil || len(sig.Results.List) == 0 {
		return parameters, ""
	}
	if len(sig.Results.List) == 1 && len(sig.Results.List[0].Names) == 0 {
		return parameters, types.ExprString(sig.Results.List[0].Type)
	}
	parts := []string{}
	for _, field := range sig.Results.List {
		typeName := types.ExprString(field.Type)
		if len(field.Names) == 0 {
			parts = append(parts, typeName)
			continue
		}
		names := make([]string, len(field.Names))
		for i, name := range field.Names {
			names[i] = name.Name
		}
		parts = append(parts, strings.Join(names, ", ")+" "+typeName)
	}
	return parameters, "(" + strings.Join(parts, ", ") + ")"
}

// satisfies lists the project interfaces with methods that a non-interface type implements, through T or *T.
// Generic types and interfaces are left out: implementation is only defined for their instances.
func (p *Project) satisfies(t *Type) []string {
	if t.Kind == "interface" || !p.Semantic {
		return nil
	}
	named := namedOf(t)
	if named == nil || named.TypeParams().Len() > 0 {
		return nil
	}
	var list []string
	for _, candidate := range p.AllTypes() {
		if candidate.Kind != "interface" {
			continue
		}
		other := namedOf(candidate)
		if other == nil || other.TypeParams().Len() > 0 {
			continue
		}
		contract, ok := other.Underlying().(*types.Interface)
		if !ok || contract.NumMethods() == 0 {
			continue
		}
		if types.Implements(named, contract) || types.Implements(types.NewPointer(named), contract) {
			list = append(list, candidate.ID)
		}
	}
	sort.Strings(list)
	return list
}

func namedOf(t *Type) *types.Named {
	if t.Spec == nil {
		return nil
	}
	if object, ok := t.Module.Info.Defs[t.Spec.Name].(*types.TypeName); ok {
		named, _ := object.Type().(*types.Named)
		return named
	}
	return nil
}
