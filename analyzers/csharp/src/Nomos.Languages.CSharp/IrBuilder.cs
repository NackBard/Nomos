using Nomos.Abstractions.Ir;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using SourceLocation = Nomos.Abstractions.Ir.SourceLocation;
using SymbolKind = Nomos.Abstractions.Ir.SymbolKind;
using RoslynTypeKind = Microsoft.CodeAnalysis.TypeKind;
using TypeKind = Nomos.Abstractions.Ir.TypeKind;

namespace Nomos.Languages.CSharp;

/// <summary>Builds IR declarations. Partial types merge by symbol; namespaces become modules.</summary>
internal sealed class IrBuilder(CSharpCompilation compilation, string language)
{
    public const string GlobalModule = "(global)";

    private readonly Dictionary<string, TypeBuilder> _types = [];
    private readonly List<TypeBuilder> _topLevel = [];
    private readonly Dictionary<string, List<Callable>> _functions = [];

    public void AddTree(SyntaxTree tree)
    {
        var model = compilation.GetSemanticModel(tree);
        var root = (CompilationUnitSyntax)tree.GetRoot();
        VisitMembers(root.Members, null, model);

        var globals = root.Members.OfType<GlobalStatementSyntax>().ToList();
        if (globals.Count == 0) return;
        var converter = new BodyConverter(model, (_, _, _) => { });
        var statements = globals.SelectMany(g => converter.Statements(g.Statement)).ToList();
        var location = Locations.Of(tree.GetLocation(TextSpan.FromBounds(globals[0].SpanStart, globals[^1].Span.End)));
        var callable = new Callable(location)
        {
            Id = $"{tree.FilePath}.<Main>",
            Name = "<Main>",
            Kind = CallableKind.Function,
            Visibility = Visibility.Private,
            Body = new BlockStatement(statements, location),
        };
        if (!_functions.TryGetValue(GlobalModule, out var list)) _functions[GlobalModule] = list = [];
        list.Add(callable);
    }

    public IReadOnlyList<ModuleDecl> BuildModules()
    {
        var names = _topLevel.Select(t => t.ModuleName).Concat(_functions.Keys).Distinct().Order(StringComparer.Ordinal);
        var modules = new List<ModuleDecl>();
        foreach (var name in names)
        {
            var types = _topLevel.Where(t => t.ModuleName == name).OrderBy(t => t.Id, StringComparer.Ordinal).Select(t => t.Build()).ToList();
            var functions = _functions.GetValueOrDefault(name) ?? [];
            modules.Add(new ModuleDecl(name, language)
            {
                Types = types,
                Functions = [.. functions.OrderBy(f => f.Id, StringComparer.Ordinal)],
                LinesOfCode = types.Sum(t => t.LineCount) + functions.Sum(f => f.Location.LineSpan),
            });
        }
        return modules;
    }

    private void VisitMembers(IEnumerable<MemberDeclarationSyntax> members, TypeBuilder? parent, SemanticModel model)
    {
        foreach (var member in members)
        {
            switch (member)
            {
                case BaseNamespaceDeclarationSyntax ns:
                    VisitMembers(ns.Members, parent, model);
                    break;
                case BaseTypeDeclarationSyntax or DelegateDeclarationSyntax:
                    VisitType(member, parent, model);
                    break;
            }
        }
    }

    private void VisitType(MemberDeclarationSyntax syntax, TypeBuilder? parent, SemanticModel model)
    {
        if (model.GetDeclaredSymbol(syntax) is not INamedTypeSymbol symbol) return;
        var id = Symbols.TypeId(symbol);
        if (!_types.TryGetValue(id, out var builder))
        {
            builder = new TypeBuilder(symbol, id);
            _types[id] = builder;
            if (parent is null) _topLevel.Add(builder);
            else parent.Nested.Add(builder);
        }
        builder.AddPart(syntax, model);
        if (syntax is TypeDeclarationSyntax type) VisitMembers(type.Members, builder, model);
    }
}

/// <summary>Accumulates one type over all of its partial declarations.</summary>
internal sealed class TypeBuilder
{
    private readonly INamedTypeSymbol _symbol;
    private readonly List<FieldDecl> _fields = [];
    private readonly List<PropertyDecl> _properties = [];
    private readonly List<EventDecl> _events = [];
    private readonly List<Callable> _callables = [];
    private readonly List<AttributeInfo> _attributes = [];
    private readonly Dictionary<(string, DependencyKind), Dependency> _dependencies = [];
    private SourceLocation _location = SourceLocation.None;
    private int _lineCount;

    public TypeBuilder(INamedTypeSymbol symbol, string id)
    {
        _symbol = symbol;
        Id = id;
        ModuleName = symbol.ContainingNamespace.IsGlobalNamespace ? IrBuilder.GlobalModule : symbol.ContainingNamespace.ToDisplayString();
    }

    public string Id { get; }

    public string ModuleName { get; }

    public List<TypeBuilder> Nested { get; } = [];

    public void AddPart(MemberDeclarationSyntax syntax, SemanticModel model)
    {
        var identifier = syntax switch
        {
            BaseTypeDeclarationSyntax t => t.Identifier,
            DelegateDeclarationSyntax d => d.Identifier,
            _ => default,
        };
        if (!_location.IsKnown)
            _location = Locations.Of(syntax.SyntaxTree.GetLocation(TextSpan.FromBounds(identifier.SpanStart, syntax.Span.End)));
        _lineCount += Locations.Of(syntax).LineSpan;

        var converter = new BodyConverter(model, AddDependency);
        _attributes.AddRange(converter.Attributes(syntax.AttributeLists));
        if (_lineCount == Locations.Of(syntax).LineSpan) AddInheritance(syntax);

        switch (syntax)
        {
            case EnumDeclarationSyntax enumeration:
                foreach (var member in enumeration.Members)
                    _fields.Add(new FieldDecl(member.Identifier.ValueText, Symbols.ToTypeRef(_symbol), Visibility.Public, Locations.Of(member))
                    { Id = $"{Id}.{member.Identifier.ValueText}", IsStatic = true, IsReadOnly = true, IsConstant = true, IsEnumValue = true });
                break;
            case DelegateDeclarationSyntax:
                if (_symbol.DelegateInvokeMethod is { } invoke)
                {
                    AddDependency(invoke.ReturnType, DependencyKind.Signature, syntax.GetLocation());
                    foreach (var parameter in invoke.Parameters) AddDependency(parameter.Type, DependencyKind.Signature, syntax.GetLocation());
                }
                break;
            case TypeDeclarationSyntax type:
                AddPrimaryConstructor(type, converter, model);
                foreach (var member in type.Members) AddMember(member, converter, model);
                break;
        }
    }

    public TypeDecl Build() => new(_location)
    {
        Id = Id,
        Name = _symbol.Name,
        Kind = _symbol switch
        {
            { IsRecord: true } => TypeKind.Record,
            { TypeKind: RoslynTypeKind.Interface } => TypeKind.Interface,
            { TypeKind: RoslynTypeKind.Struct } => TypeKind.Struct,
            { TypeKind: RoslynTypeKind.Enum } => TypeKind.Enum,
            { TypeKind: RoslynTypeKind.Delegate } => TypeKind.Delegate,
            _ => TypeKind.Class,
        },
        Visibility = Symbols.VisibilityOf(_symbol),
        Modifiers = Symbols.ModifiersOf(_symbol),
        ModuleName = ModuleName,
        TypeParameters = [.. _symbol.TypeParameters.Select(p => p.Name)],
        BaseType = _symbol.BaseType is { SpecialType: SpecialType.None } baseType ? Symbols.ToTypeRef(baseType) : null,
        Interfaces = [.. DeclaredInterfaces().Select(i => Symbols.ToTypeRef(i)!)],
        InheritanceDepth = Depth(),
        Fields = _fields,
        Properties = _properties,
        Events = _events,
        Callables = _callables,
        NestedTypes = [.. Nested.OrderBy(n => n.Id, StringComparer.Ordinal).Select(n => n.Build())],
        Attributes = _attributes,
        Dependencies = [.. _dependencies.Values.OrderBy(d => d.TargetTypeId, StringComparer.Ordinal).ThenBy(d => d.Kind)],
        LineCount = _lineCount,
    };

    private IEnumerable<INamedTypeSymbol> DeclaredInterfaces() =>
        _symbol.Interfaces.Where(i => !(_symbol.IsRecord && i.Name == "IEquatable"));

    private int Depth()
    {
        if (_symbol.TypeKind != RoslynTypeKind.Class) return 0;
        var depth = 0;
        for (var current = _symbol.BaseType; current is { SpecialType: SpecialType.None }; current = current.BaseType) depth++;
        return depth;
    }

    private void AddInheritance(MemberDeclarationSyntax syntax)
    {
        if (_symbol.BaseType is { SpecialType: SpecialType.None } baseType) AddDependency(baseType, DependencyKind.Inheritance, syntax.GetLocation());
        foreach (var contract in DeclaredInterfaces()) AddDependency(contract, DependencyKind.Implementation, syntax.GetLocation());
    }

    private void AddDependency(ITypeSymbol? type, DependencyKind kind, Location location)
    {
        switch (type)
        {
            case IArrayTypeSymbol array:
                AddDependency(array.ElementType, kind, location);
                break;
            case IPointerTypeSymbol pointer:
                AddDependency(pointer.PointedAtType, kind, location);
                break;
            case INamedTypeSymbol { TypeKind: not RoslynTypeKind.Error } named:
                // A type argument of a base is used by the declaration, not inherited from (spec/metrics.md).
                var argumentKind = kind is DependencyKind.Inheritance or DependencyKind.Implementation ? DependencyKind.Usage : kind;
                foreach (var argument in named.TypeArguments) AddDependency(argument, argumentKind, location);
                if (named.SpecialType != SpecialType.None || named.IsAnonymousType) return;
                var target = Symbols.TypeId(named);
                if (target != Id) _dependencies.TryAdd((target, kind), new Dependency(Id, target, kind, Symbols.IsExternal(named), Locations.Of(location)));
                break;
        }
    }

    private void AddPrimaryConstructor(TypeDeclarationSyntax type, BodyConverter converter, SemanticModel model)
    {
        if (type.ParameterList is not { } list) return;
        var parameters = converter.Parameters(list);
        foreach (var parameter in list.Parameters)
            if (model.GetDeclaredSymbol(parameter) is { } symbol) AddDependency(symbol.Type, DependencyKind.Signature, parameter.GetLocation());

        // Arguments passed to the base constructor are the first code of a primary constructor.
        var location = Locations.Of(list);
        var baseArguments = type.BaseList?.Types.OfType<PrimaryConstructorBaseTypeSyntax>().SelectMany(b => b.ArgumentList.Arguments)
            .Select(a => (Statement)new ExpressionStatement(converter.Expression(a.Expression), Locations.Of(a))).ToList() ?? [];
        _callables.Add(new Callable(location)
        {
            Id = $"{Id}.{type.Identifier.ValueText}({string.Join(",", parameters.Select(p => p.Type?.Name))})",
            Name = type.Identifier.ValueText,
            Kind = CallableKind.Constructor,
            Visibility = Visibility.Public,
            Parameters = parameters,
            Body = new BlockStatement(baseArguments, location),
            DeclaringTypeId = Id,
        });

        foreach (var parameter in parameters)
        {
            if (_symbol.IsRecord)
                _properties.Add(new PropertyDecl(parameter.Name, parameter.Type, Visibility.Public, parameter.Location)
                { Id = $"{Id}.{parameter.Name}", HasGetter = true, IsInitOnly = true, IsAuto = true, TypeText = parameter.TypeText });
            else
                _fields.Add(new FieldDecl(parameter.Name, parameter.Type, Visibility.Private, parameter.Location)
                { Id = $"{Id}.{parameter.Name}", IsReadOnly = true, TypeText = parameter.TypeText });
        }
    }

    private void AddMember(MemberDeclarationSyntax member, BodyConverter converter, SemanticModel model)
    {
        switch (member)
        {
            case FieldDeclarationSyntax field:
                foreach (var variable in field.Declaration.Variables) AddField(variable, converter, model);
                break;
            case EventFieldDeclarationSyntax eventField:
                foreach (var variable in eventField.Declaration.Variables)
                {
                    if (model.GetDeclaredSymbol(variable) is not IEventSymbol symbol) continue;
                    AddDependency(symbol.Type, DependencyKind.Member, variable.GetLocation());
                    _events.Add(new EventDecl(symbol.Name, Symbols.ToTypeRef(symbol.Type), Symbols.VisibilityOf(symbol), Locations.Of(variable))
                    { IsStatic = symbol.IsStatic, TypeText = Syntax.Text(eventField.Declaration.Type) });
                }
                break;
            case EventDeclarationSyntax eventDeclaration:
                if (model.GetDeclaredSymbol(eventDeclaration) is { } eventSymbol)
                {
                    AddDependency(eventSymbol.Type, DependencyKind.Member, eventDeclaration.GetLocation());
                    _events.Add(new EventDecl(eventSymbol.Name, Symbols.ToTypeRef(eventSymbol.Type), Symbols.VisibilityOf(eventSymbol), Locations.Of(eventDeclaration))
                    { IsStatic = eventSymbol.IsStatic, TypeText = Syntax.Text(eventDeclaration.Type) });
                }
                break;
            case BasePropertyDeclarationSyntax property:
                AddProperty(property, converter, model);
                break;
            case BaseMethodDeclarationSyntax method:
                AddMethod(method, converter, model);
                break;
        }
    }

    private void AddField(VariableDeclaratorSyntax variable, BodyConverter converter, SemanticModel model)
    {
        if (model.GetDeclaredSymbol(variable) is not IFieldSymbol symbol) return;
        AddDependency(symbol.Type, DependencyKind.Member, variable.GetLocation());
        _fields.Add(new FieldDecl(symbol.Name, Symbols.ToTypeRef(symbol.Type), Symbols.VisibilityOf(symbol), Locations.Of(variable))
        {
            Id = $"{Id}.{symbol.Name}",
            IsStatic = symbol.IsStatic,
            IsReadOnly = symbol.IsReadOnly || symbol.IsConst,
            IsConstant = symbol.IsConst,
            Initializer = variable.Initializer is { } init ? converter.Expression(init.Value) : null,
            TypeText = (variable.Parent as VariableDeclarationSyntax)?.Type is { } type ? Syntax.Text(type) : null,
        });
    }

    private void AddProperty(BasePropertyDeclarationSyntax property, BodyConverter converter, SemanticModel model)
    {
        if (model.GetDeclaredSymbol(property) is not IPropertySymbol symbol) return;
        AddDependency(symbol.Type, DependencyKind.Member, property.GetLocation());
        var accessors = property.AccessorList?.Accessors ?? [];
        var arrow = (property as PropertyDeclarationSyntax)?.ExpressionBody ?? (property as IndexerDeclarationSyntax)?.ExpressionBody;
        var location = Locations.Of(property);
        _properties.Add(new PropertyDecl(symbol.Name, Symbols.ToTypeRef(symbol.Type), Symbols.VisibilityOf(symbol), location)
        {
            Id = $"{Id}.{symbol.Name}",
            HasGetter = symbol.GetMethod is not null,
            SetterVisibility = symbol.SetMethod is { IsInitOnly: false } setter ? Symbols.VisibilityOf(setter) : null,
            IsInitOnly = symbol.SetMethod?.IsInitOnly == true,
            IsAuto = arrow is null && accessors.All(a => a.Body is null && a.ExpressionBody is null) && !symbol.IsAbstract && symbol.ContainingType.TypeKind != RoslynTypeKind.Interface,
            IsStatic = symbol.IsStatic,
            Modifiers = Symbols.ModifiersOf(symbol),
            Initializer = (property as PropertyDeclarationSyntax)?.Initializer is { } init ? converter.Expression(init.Value) : null,
            TypeText = Syntax.Text(property.Type),
        });

        if (arrow is not null)
            _callables.Add(AccessorCallable($"get_{symbol.Name}", symbol, converter.Parameters(null), converter.ArrowBody(arrow, isVoid: false), Locations.Of(arrow)));
        foreach (var accessor in accessors.Where(a => a.Body is not null || a.ExpressionBody is not null))
        {
            var isGetter = accessor.Keyword.IsKind(SyntaxKind.GetKeyword);
            var body = accessor.Body is { } block ? converter.Block(block) : converter.ArrowBody(accessor.ExpressionBody!, !isGetter);
            _callables.Add(AccessorCallable($"{accessor.Keyword.ValueText}_{symbol.Name}", symbol, [], body, Locations.Of(accessor)));
        }
    }

    private Callable AccessorCallable(string name, IPropertySymbol property, IReadOnlyList<Parameter> parameters, BlockStatement body, SourceLocation location) => new(location)
    {
        Id = $"{Id}.{name}",
        Name = name,
        Kind = CallableKind.Accessor,
        Visibility = Symbols.VisibilityOf(property),
        Modifiers = Symbols.ModifiersOf(property),
        Parameters = parameters,
        ReturnType = name.StartsWith("get_", StringComparison.Ordinal) ? Symbols.ToTypeRef(property.Type) : null,
        Body = body,
        DeclaringTypeId = Id,
    };

    private void AddMethod(BaseMethodDeclarationSyntax method, BodyConverter converter, SemanticModel model)
    {
        if (model.GetDeclaredSymbol(method) is not IMethodSymbol symbol) return;
        AddDependency(symbol.ReturnType, DependencyKind.Signature, method.GetLocation());
        foreach (var parameter in symbol.Parameters) AddDependency(parameter.Type, DependencyKind.Signature, method.GetLocation());

        var identifier = method switch
        {
            MethodDeclarationSyntax m => m.Identifier,
            ConstructorDeclarationSyntax c => c.Identifier,
            DestructorDeclarationSyntax d => d.Identifier,
            OperatorDeclarationSyntax o => o.OperatorToken,
            ConversionOperatorDeclarationSyntax c => c.ImplicitOrExplicitKeyword,
            _ => method.GetFirstToken(),
        };
        var location = Locations.Of(method.SyntaxTree.GetLocation(TextSpan.FromBounds(identifier.SpanStart, method.Span.End)));
        BlockStatement? body = method.Body is { } block ? converter.Block(block)
            : method.ExpressionBody is { } arrow ? converter.ArrowBody(arrow, symbol.ReturnsVoid)
            : null;

        if (method is ConstructorDeclarationSyntax { Initializer: { } initializer } && body is not null)
        {
            var arguments = initializer.ArgumentList.Arguments.Select(a => (IrNode)converter.Expression(a.Expression)).ToList();
            body = body with { Statements = [new OpaqueStatement(arguments, Locations.Of(initializer)), .. body.Statements] };
        }

        _callables.Add(new Callable(location)
        {
            Id = Symbols.MemberId(symbol),
            Name = method is ConstructorDeclarationSyntax or DestructorDeclarationSyntax ? _symbol.Name : symbol.Name,
            Kind = method switch
            {
                ConstructorDeclarationSyntax => CallableKind.Constructor,
                DestructorDeclarationSyntax => CallableKind.Destructor,
                OperatorDeclarationSyntax or ConversionOperatorDeclarationSyntax => CallableKind.Operator,
                _ => CallableKind.Method,
            },
            Visibility = Symbols.VisibilityOf(symbol),
            Modifiers = Symbols.ModifiersOf(symbol),
            Parameters = converter.Parameters(method.ParameterList),
            ReturnType = symbol.ReturnsVoid ? null : Symbols.ToTypeRef(symbol.ReturnType),
            ReturnTypeText = symbol.ReturnsVoid ? null : method switch
            {
                MethodDeclarationSyntax m => Syntax.Text(m.ReturnType),
                OperatorDeclarationSyntax o => Syntax.Text(o.ReturnType),
                ConversionOperatorDeclarationSyntax c => Syntax.Text(c.Type),
                _ => null,
            },
            Body = body,
            Attributes = converter.Attributes(method.AttributeLists),
            DeclaringTypeId = Id,
            Implements = Implemented(symbol),
            HasDocumentation = method.GetLeadingTrivia().Any(t =>
                t.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia) || t.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia)),
        });
    }

    private static List<string> Implemented(IMethodSymbol symbol)
    {
        var result = new List<string>();
        if (symbol.OverriddenMethod is { } overridden) result.Add(Symbols.MemberId(overridden));
        foreach (var contract in symbol.ContainingType.AllInterfaces)
        {
            foreach (var member in contract.GetMembers().OfType<IMethodSymbol>())
            {
                if (SymbolEqualityComparer.Default.Equals(symbol.ContainingType.FindImplementationForInterfaceMember(member), symbol))
                    result.Add(Symbols.MemberId(member));
            }
        }
        return result;
    }
}

/// <summary>Maps Roslyn symbols to IR references.</summary>
internal static class Symbols
{
    private static readonly SymbolDisplayFormat TypeFormat = new(
        globalNamespaceStyle: SymbolDisplayGlobalNamespaceStyle.Omitted,
        typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameAndContainingTypesAndNamespaces,
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters);

    public static string TypeId(ITypeSymbol symbol) => symbol.OriginalDefinition.ToDisplayString(TypeFormat);

    public static string MemberId(ISymbol symbol)
    {
        var original = symbol.OriginalDefinition;
        var owner = original.ContainingType is { } type ? TypeId(type) : string.Empty;
        if (original is IMethodSymbol method)
        {
            method = method.ReducedFrom ?? method;
            var parameters = string.Join(",", method.Parameters.Select(p => p.Type.ToDisplayString(TypeFormat)));
            return $"{owner}.{method.Name}({parameters})";
        }
        return $"{owner}.{original.Name}";
    }

    public static bool IsExternal(ISymbol symbol) => !symbol.Locations.Any(l => l.IsInSource);

    public static TypeRef? ToTypeRef(ITypeSymbol? type)
    {
        if (type is null || type.SpecialType == SpecialType.System_Void) return null;
        var name = type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat);
        if (type.TypeKind == RoslynTypeKind.Error) return new TypeRef(name, null, TypeRefKind.Unknown, true);

        var kind = type switch
        {
            IArrayTypeSymbol => TypeRefKind.Array,
            ITypeParameterSymbol => TypeRefKind.TypeParameter,
            { IsTupleType: true } => TypeRefKind.Tuple,
            { SpecialType: not SpecialType.None and not SpecialType.System_Object } => TypeRefKind.Primitive,
            { TypeKind: RoslynTypeKind.Delegate or RoslynTypeKind.FunctionPointer } => TypeRefKind.Function,
            { TypeKind: RoslynTypeKind.Interface } => TypeRefKind.Interface,
            { TypeKind: RoslynTypeKind.Enum } => TypeRefKind.Enum,
            { TypeKind: RoslynTypeKind.Struct } => TypeRefKind.Struct,
            { TypeKind: RoslynTypeKind.Class } => TypeRefKind.Class,
            _ => TypeRefKind.Unknown,
        };
        IReadOnlyList<ITypeSymbol> arguments = type switch
        {
            IArrayTypeSymbol array => [array.ElementType],
            INamedTypeSymbol named => named.TypeArguments,
            _ => [],
        };
        return new TypeRef(name, TypeId(type), kind, IsExternal(type)) { TypeArguments = [.. arguments.Select(a => ToTypeRef(a)!)] };
    }

    public static Visibility VisibilityOf(ISymbol symbol) => symbol.DeclaredAccessibility switch
    {
        Accessibility.Public => Visibility.Public,
        Accessibility.Protected or Accessibility.ProtectedOrInternal => Visibility.Protected,
        Accessibility.Private => Visibility.Private,
        _ => Visibility.Internal,
    };

    public static Modifiers ModifiersOf(ISymbol symbol)
    {
        var modifiers = Modifiers.None;
        if (symbol.IsStatic) modifiers |= Modifiers.Static;
        if (symbol.IsAbstract) modifiers |= Modifiers.Abstract;
        if (symbol.IsVirtual) modifiers |= Modifiers.Virtual;
        if (symbol.IsOverride) modifiers |= Modifiers.Override;
        if (symbol.IsSealed) modifiers |= Modifiers.Sealed;
        if (symbol.IsExtern) modifiers |= Modifiers.Extern;
        if (symbol is IMethodSymbol { IsAsync: true }) modifiers |= Modifiers.Async;
        if (symbol is IMethodSymbol { IsExtensionMethod: true }) modifiers |= Modifiers.Extension;
        if (symbol is INamedTypeSymbol type && type.DeclaringSyntaxReferences.Length > 1) modifiers |= Modifiers.Partial;
        return modifiers;
    }

    public static SymbolRef ToRef(ISymbol? symbol, string fallbackName) => symbol switch
    {
        ILocalSymbol or IRangeVariableSymbol => new SymbolRef(SymbolKind.Local, symbol.Name),
        IParameterSymbol { ContainingSymbol: IMethodSymbol { MethodKind: MethodKind.Constructor } constructor } primary
            when constructor.DeclaringSyntaxReferences.Any(r => r.GetSyntax() is TypeDeclarationSyntax) =>
            new SymbolRef(SymbolKind.Field, primary.Name) { Id = $"{TypeId(constructor.ContainingType)}.{primary.Name}", DeclaringTypeId = TypeId(constructor.ContainingType) },
        IParameterSymbol => new SymbolRef(SymbolKind.Parameter, symbol.Name),
        IFieldSymbol field => Member(SymbolKind.Field, field, field.IsStatic || field.IsConst),
        IPropertySymbol property => Member(SymbolKind.Property, property, property.IsStatic),
        IEventSymbol @event => Member(SymbolKind.Event, @event, @event.IsStatic),
        IMethodSymbol method => Member(SymbolKind.Callable, method, method.IsStatic && method.ReducedFrom is null),
        ITypeSymbol type => new SymbolRef(SymbolKind.Type, type.Name) { Id = TypeId(type), IsExternal = IsExternal(type) },
        INamespaceSymbol ns => new SymbolRef(SymbolKind.Namespace, ns.Name),
        _ => new SymbolRef(SymbolKind.Unknown, fallbackName),
    };

    private static SymbolRef Member(SymbolKind kind, ISymbol symbol, bool isStatic) => new(kind, symbol.Name)
    {
        Id = MemberId(symbol),
        DeclaringTypeId = symbol.ContainingType is { } type ? TypeId(type) : null,
        IsStatic = isStatic,
        IsExternal = IsExternal(symbol),
    };
}

/// <summary>Converts bodies. Unknown constructs become opaque nodes, which keeps their nested expressions visible.</summary>
internal sealed class BodyConverter(SemanticModel model, Action<ITypeSymbol?, DependencyKind, Location> onDependency)
{
    private readonly Stack<Abstractions.Ir.Expression> _conditionalTargets = new();

    public IReadOnlyList<Parameter> Parameters(BaseParameterListSyntax? list) =>
        list is null ? [] : [.. list.Parameters.Select(Parameter)];

    private Parameter Parameter(ParameterSyntax syntax)
    {
        var symbol = model.GetDeclaredSymbol(syntax);
        return new Parameter(syntax.Identifier.ValueText, Symbols.ToTypeRef(symbol?.Type), Locations.Of(syntax))
        {
            IsByReference = symbol?.RefKind is RefKind.Ref or RefKind.Out,
            HasDefault = syntax.Default is not null,
            TypeText = syntax.Type is { } type ? Syntax.Text(type, syntax.Modifiers.Where(m => !m.IsKind(SyntaxKind.ThisKeyword))) : null,
        };
    }

    public IReadOnlyList<AttributeInfo> Attributes(SyntaxList<AttributeListSyntax> lists)
    {
        var result = new List<AttributeInfo>();
        foreach (var attribute in lists.SelectMany(l => l.Attributes))
        {
            onDependency(model.GetTypeInfo(attribute).Type, DependencyKind.Annotation, attribute.GetLocation());
            var name = attribute.Name.ToString();
            name = name[(name.LastIndexOf('.') + 1)..];
            if (name.EndsWith("Attribute", StringComparison.Ordinal)) name = name[..^"Attribute".Length];
            var arguments = attribute.ArgumentList?.Arguments
                .Select(a => model.GetConstantValue(a.Expression) is { HasValue: true, Value: { } value } ? value.ToString() ?? string.Empty : string.Empty)
                .ToList() ?? [];
            result.Add(new AttributeInfo(name, arguments, Locations.Of(attribute)));
        }
        return result;
    }

    public BlockStatement Block(BlockSyntax block) => new([.. block.Statements.SelectMany(Statements)], Locations.Of(block));

    public BlockStatement ArrowBody(ArrowExpressionClauseSyntax arrow, bool isVoid) => ExpressionBody(arrow.Expression, isVoid);

    private BlockStatement ExpressionBody(ExpressionSyntax syntax, bool isVoid)
    {
        var location = Locations.Of(syntax);
        var expression = Expression(syntax);
        return new BlockStatement([isVoid ? new ExpressionStatement(expression, location) : new ReturnStatement(expression, location)], location);
    }

    private Statement Single(StatementSyntax syntax)
    {
        var statements = Statements(syntax).ToList();
        return statements.Count == 1 ? statements[0] : new BlockStatement(statements, Locations.Of(syntax));
    }

    public IEnumerable<Statement> Statements(StatementSyntax syntax)
    {
        var location = Locations.Of(syntax);
        switch (syntax)
        {
            case LocalDeclarationStatementSyntax local:
                foreach (var declaration in LocalDeclarations(local.Declaration, !local.IsConst)) yield return declaration;
                break;
            case BlockSyntax block:
                yield return Block(block);
                break;
            case ExpressionStatementSyntax expression:
                yield return new ExpressionStatement(Expression(expression.Expression), location);
                break;
            case IfStatementSyntax branch:
                yield return new IfStatement(Expression(branch.Condition), Single(branch.Statement), branch.Else is { } e ? Single(e.Statement) : null, location);
                break;
            case WhileStatementSyntax loop:
                yield return new LoopStatement(LoopKind.While, Single(loop.Statement), location) { Condition = Expression(loop.Condition) };
                break;
            case DoStatementSyntax loop:
                yield return new LoopStatement(LoopKind.DoWhile, Single(loop.Statement), location) { Condition = Expression(loop.Condition) };
                break;
            case ForStatementSyntax loop:
                yield return new LoopStatement(LoopKind.For, Single(loop.Statement), location)
                {
                    Initializers =
                    [
                        .. loop.Declaration is { } d ? LocalDeclarations(d, true) : [],
                        .. loop.Initializers.Select(i => new ExpressionStatement(Expression(i), Locations.Of(i))),
                    ],
                    Condition = loop.Condition is { } condition ? Expression(condition) : null,
                    Updates = [.. loop.Incrementors.Select(Expression)],
                };
                break;
            case ForEachStatementSyntax loop:
                onDependency(model.GetTypeInfo(loop.Type).Type, DependencyKind.Usage, loop.Type.GetLocation());
                yield return new LoopStatement(LoopKind.ForEach, Single(loop.Statement), location) { Iterable = Expression(loop.Expression), Variable = loop.Identifier.ValueText };
                break;
            case ForEachVariableStatementSyntax loop:
                yield return new LoopStatement(LoopKind.ForEach, Single(loop.Statement), location) { Iterable = Expression(loop.Expression) };
                break;
            case SwitchStatementSyntax choice:
                yield return new SwitchStatement(Expression(choice.Expression), [.. choice.Sections.Select(Section)], location);
                break;
            case TryStatementSyntax attempt:
                yield return new TryStatement(Block(attempt.Block), [.. attempt.Catches.Select(Catch)], attempt.Finally is { } f ? Block(f.Block) : null, location);
                break;
            case ReturnStatementSyntax exit:
                yield return new ReturnStatement(exit.Expression is { } value ? Expression(value) : null, location);
                break;
            case ThrowStatementSyntax raise:
                yield return new ThrowStatement(raise.Expression is { } thrown ? Expression(thrown) : null, location);
                break;
            case BreakStatementSyntax:
                yield return new BreakStatement(location);
                break;
            case ContinueStatementSyntax:
                yield return new ContinueStatement(location);
                break;
            case GotoStatementSyntax jump:
                yield return new GotoStatement(jump.CaseOrDefaultKeyword.IsKind(SyntaxKind.CaseKeyword) ? $"case {jump.Expression}" : jump.Expression?.ToString() ?? "default", location);
                break;
            case LabeledStatementSyntax labeled:
                yield return new LabeledStatement(labeled.Identifier.ValueText, Single(labeled.Statement), location);
                break;
            case YieldStatementSyntax yielded:
                yield return new YieldStatement(yielded.Expression is { } item ? Expression(item) : null, location);
                break;
            case LockStatementSyntax guarded:
                yield return new ScopedStatement("lock", Expression(guarded.Expression), Single(guarded.Statement), location);
                break;
            case UsingStatementSyntax guarded:
                var resource = guarded.Expression is { } used ? Expression(used) : null;
                var declared = guarded.Declaration is { } usingDeclaration ? LocalDeclarations(usingDeclaration, false).ToList() : [];
                var inner = Single(guarded.Statement);
                yield return new ScopedStatement("using", resource, declared.Count == 0 ? inner : new BlockStatement([.. declared, inner], location), location);
                break;
            case FixedStatementSyntax guarded:
                yield return new ScopedStatement("fixed", null, Single(guarded.Statement), location);
                break;
            case CheckedStatementSyntax guarded:
                yield return Block(guarded.Block);
                break;
            case UnsafeStatementSyntax guarded:
                yield return Block(guarded.Block);
                break;
            case LocalFunctionStatementSyntax function:
                yield return new LocalFunctionStatement(LocalFunction(function), location);
                break;
            default:
                yield return new OpaqueStatement([.. ChildExpressions(syntax).Select(Expression)], location);
                break;
        }
    }

    private IEnumerable<Statement> LocalDeclarations(VariableDeclarationSyntax declaration, bool isMutable)
    {
        foreach (var variable in declaration.Variables)
        {
            var symbol = model.GetDeclaredSymbol(variable) as ILocalSymbol;
            onDependency(symbol?.Type, DependencyKind.Usage, variable.GetLocation());
            yield return new LocalDeclaration(variable.Identifier.ValueText, Symbols.ToTypeRef(symbol?.Type),
                variable.Initializer is { } init ? Expression(init.Value) : null, isMutable, Locations.Of(variable));
        }
    }

    private Callable LocalFunction(LocalFunctionStatementSyntax syntax)
    {
        var symbol = model.GetDeclaredSymbol(syntax) as IMethodSymbol;
        var body = syntax.Body is { } block ? Block(block)
            : syntax.ExpressionBody is { } arrow ? ArrowBody(arrow, symbol?.ReturnsVoid == true)
            : null;
        return new Callable(Locations.Of(syntax))
        {
            Id = symbol is null ? syntax.Identifier.ValueText : Symbols.MemberId(symbol),
            Name = syntax.Identifier.ValueText,
            Kind = CallableKind.LocalFunction,
            Visibility = Visibility.Private,
            Modifiers = symbol is null ? Modifiers.None : Symbols.ModifiersOf(symbol),
            Parameters = Parameters(syntax.ParameterList),
            ReturnType = symbol?.ReturnsVoid == true ? null : Symbols.ToTypeRef(symbol?.ReturnType),
            Body = body,
        };
    }

    private SwitchSection Section(SwitchSectionSyntax section)
    {
        var labels = new List<Abstractions.Ir.Expression>();
        foreach (var label in section.Labels)
        {
            if (label is CaseSwitchLabelSyntax value) labels.Add(Expression(value.Value));
            else if (label is CasePatternSwitchLabelSyntax pattern)
            {
                labels.Add(Pattern(pattern.Pattern, null));
                if (pattern.WhenClause is { } when) labels.Add(Expression(when.Condition));
            }
        }
        return new SwitchSection(labels, [.. section.Statements.SelectMany(Statements)], Locations.Of(section));
    }

    private CatchClause Catch(CatchClauseSyntax clause)
    {
        var type = clause.Declaration is { } declaration ? model.GetTypeInfo(declaration.Type).Type : null;
        onDependency(type, DependencyKind.Usage, clause.GetLocation());
        return new CatchClause(Symbols.ToTypeRef(type), clause.Filter is { } filter ? Expression(filter.FilterExpression) : null, Block(clause.Block), Locations.Of(clause));
    }

    private Abstractions.Ir.Expression Pattern(PatternSyntax pattern, Abstractions.Ir.Expression? operand)
    {
        var location = Locations.Of(pattern);
        TypeSyntax? typeSyntax = pattern switch
        {
            DeclarationPatternSyntax d => d.Type,
            TypePatternSyntax t => t.Type,
            RecursivePatternSyntax r => r.Type,
            ConstantPatternSyntax { Expression: TypeSyntax c } when model.GetSymbolInfo(c).Symbol is ITypeSymbol => c,
            _ => null,
        };
        var subject = operand ?? new OpaqueExpression([], location);
        if (typeSyntax is not null)
        {
            var type = model.GetTypeInfo(typeSyntax).Type;
            onDependency(type, DependencyKind.Usage, typeSyntax.GetLocation());
            return new TypeTestExpression(subject, Symbols.ToTypeRef(type), location);
        }
        return pattern is ConstantPatternSyntax constant
            ? new BinaryExpression("==", subject, Expression(constant.Expression), location)
            : new TypeTestExpression(subject, null, location);
    }

    private IEnumerable<ExpressionSyntax> ChildExpressions(SyntaxNode node) =>
        node.DescendantNodes(n => n == node || n is not ExpressionSyntax).OfType<ExpressionSyntax>();

    public Abstractions.Ir.Expression Expression(ExpressionSyntax syntax)
    {
        var converted = ConvertExpression(syntax);
        return syntax is LambdaExpressionSyntax or AnonymousMethodExpressionSyntax
            ? converted
            : converted with { Type = Symbols.ToTypeRef(model.GetTypeInfo(syntax).Type) };
    }

    private SymbolRef Bind(ExpressionSyntax syntax, string fallbackName)
    {
        var info = model.GetSymbolInfo(syntax);
        return Symbols.ToRef(info.Symbol ?? info.CandidateSymbols.FirstOrDefault(), fallbackName);
    }

    private Abstractions.Ir.Expression ConvertExpression(ExpressionSyntax syntax)
    {
        var location = Locations.Of(syntax);
        switch (syntax)
        {
            case ParenthesizedExpressionSyntax parenthesized:
                return Expression(parenthesized.Expression);
            case LiteralExpressionSyntax literal:
                return new LiteralExpression(literal.Kind() switch
                {
                    SyntaxKind.NumericLiteralExpression => LiteralKind.Number,
                    SyntaxKind.StringLiteralExpression or SyntaxKind.Utf8StringLiteralExpression => LiteralKind.String,
                    SyntaxKind.TrueLiteralExpression or SyntaxKind.FalseLiteralExpression => LiteralKind.Boolean,
                    SyntaxKind.NullLiteralExpression => LiteralKind.Null,
                    _ => LiteralKind.Other,
                }, literal.Token.ValueText, location);
            case ThisExpressionSyntax:
                return new NameExpression(new SymbolRef(SymbolKind.This, "this"), location);
            case BaseExpressionSyntax:
                return new NameExpression(new SymbolRef(SymbolKind.Base, "base"), location);
            case MemberAccessExpressionSyntax access:
                if (model.GetSymbolInfo(access.Expression).Symbol is ITypeSymbol staticOwner) onDependency(staticOwner, DependencyKind.Invocation, access.GetLocation());
                return new MemberAccessExpression(Expression(access.Expression), Bind(access, access.Name.Identifier.ValueText), location);
            case ConditionalAccessExpressionSyntax conditional:
                _conditionalTargets.Push(Expression(conditional.Expression));
                var whenNotNull = Expression(conditional.WhenNotNull);
                _conditionalTargets.Pop();
                return whenNotNull;
            case MemberBindingExpressionSyntax binding:
                return new MemberAccessExpression(_conditionalTargets.Peek(), Bind(binding, binding.Name.Identifier.ValueText), location);
            case ElementBindingExpressionSyntax binding:
                return new ElementAccessExpression(_conditionalTargets.Peek(), Arguments(binding.ArgumentList), location);
            case InvocationExpressionSyntax invocation:
                var target = Bind(invocation, invocation.Expression.ToString());
                if (model.GetSymbolInfo(invocation).Symbol is IMethodSymbol called) onDependency(called.ContainingType, DependencyKind.Invocation, invocation.GetLocation());
                return new InvocationExpression(Expression(invocation.Expression), Arguments(invocation.ArgumentList), target, location);
            case BaseObjectCreationExpressionSyntax creation:
                var created = model.GetTypeInfo(creation).Type;
                onDependency(created, DependencyKind.Creation, creation.GetLocation());
                return new ObjectCreationExpression(Symbols.ToTypeRef(created) ?? Unknown(creation), creation.ArgumentList is { } a ? Arguments(a) : [], Initializers(creation.Initializer), location);
            case ArrayCreationExpressionSyntax array:
                onDependency(model.GetTypeInfo(array).Type, DependencyKind.Creation, array.GetLocation());
                return new ObjectCreationExpression(Symbols.ToTypeRef(model.GetTypeInfo(array).Type) ?? Unknown(array),
                    [.. array.Type.RankSpecifiers.SelectMany(r => r.Sizes).Where(s => s is not OmittedArraySizeExpressionSyntax).Select(Expression)], Initializers(array.Initializer), location);
            case ImplicitArrayCreationExpressionSyntax array:
                return new ObjectCreationExpression(Symbols.ToTypeRef(model.GetTypeInfo(array).Type) ?? Unknown(array), [], Initializers(array.Initializer), location);
            case InitializerExpressionSyntax initializer:
                return new CollectionExpression(Initializers(initializer), location);
            case CollectionExpressionSyntax collection:
                return new CollectionExpression([.. collection.Elements.SelectMany(e => ChildExpressions(e)).Select(Expression)], location);
            case TupleExpressionSyntax tuple:
                return new CollectionExpression([.. tuple.Arguments.Select(a => Expression(a.Expression))], location);
            case AnonymousObjectCreationExpressionSyntax anonymous:
                return new CollectionExpression([.. anonymous.Initializers.Select(i => Expression(i.Expression))], location);
            case AssignmentExpressionSyntax assignment:
                return new AssignmentExpression(Expression(assignment.Left), Expression(assignment.Right), assignment.OperatorToken.Text, location);
            case BinaryExpressionSyntax { RawKind: (int)SyntaxKind.IsExpression } test:
                var tested = model.GetTypeInfo(test.Right).Type;
                onDependency(tested, DependencyKind.Usage, test.GetLocation());
                return new TypeTestExpression(Expression(test.Left), Symbols.ToTypeRef(tested), location);
            case BinaryExpressionSyntax { RawKind: (int)SyntaxKind.AsExpression } cast:
                var castType = model.GetTypeInfo(cast.Right).Type;
                onDependency(castType, DependencyKind.Usage, cast.GetLocation());
                return new CastExpression(Symbols.ToTypeRef(castType) ?? Unknown(cast.Right), Expression(cast.Left), location);
            case BinaryExpressionSyntax binary:
                return new BinaryExpression(binary.OperatorToken.Text, Expression(binary.Left), Expression(binary.Right), location);
            case IsPatternExpressionSyntax pattern:
                return Pattern(pattern.Pattern, Expression(pattern.Expression));
            case PrefixUnaryExpressionSyntax unary:
                return new UnaryExpression(unary.OperatorToken.Text, Expression(unary.Operand), unary.OperatorToken.Text is "++" or "--", location);
            case PostfixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.SuppressNullableWarningExpression } forgiving:
                return Expression(forgiving.Operand);
            case PostfixUnaryExpressionSyntax unary:
                return new UnaryExpression(unary.OperatorToken.Text, Expression(unary.Operand), true, location);
            case ConditionalExpressionSyntax ternary:
                return new ConditionalExpression(Expression(ternary.Condition), Expression(ternary.WhenTrue), Expression(ternary.WhenFalse), location);
            case AnonymousFunctionExpressionSyntax lambda:
                return Lambda(lambda, location);
            case ElementAccessExpressionSyntax element:
                return new ElementAccessExpression(Expression(element.Expression), Arguments(element.ArgumentList), location);
            case CastExpressionSyntax cast:
                var converted = model.GetTypeInfo(cast.Type).Type;
                onDependency(converted, DependencyKind.Usage, cast.GetLocation());
                return new CastExpression(Symbols.ToTypeRef(converted) ?? Unknown(cast.Type), Expression(cast.Expression), location);
            case AwaitExpressionSyntax wait:
                return new AwaitExpression(Expression(wait.Expression), location);
            case InterpolatedStringExpressionSyntax interpolated:
                return new InterpolatedStringExpression([.. interpolated.Contents.Select(c => c switch
                {
                    InterpolationSyntax hole => Expression(hole.Expression),
                    _ => new LiteralExpression(LiteralKind.String, c.ToString(), Locations.Of(c)),
                })], location);
            case SwitchExpressionSyntax choice:
                return new SwitchExpression(Expression(choice.GoverningExpression), [.. choice.Arms.Select(Arm)], location);
            case TypeOfExpressionSyntax typeOf:
                onDependency(model.GetTypeInfo(typeOf.Type).Type, DependencyKind.Usage, typeOf.GetLocation());
                return new OpaqueExpression([], location);
            case TypeSyntax name:
                return new NameExpression(Bind(name, name is SimpleNameSyntax simple ? simple.Identifier.ValueText : name.ToString()), location);
            default:
                return new OpaqueExpression([.. ChildExpressions(syntax).Select(Expression)], location);
        }
    }

    private SwitchArm Arm(SwitchExpressionArmSyntax arm)
    {
        var pattern = arm.Pattern is DiscardPatternSyntax ? null : Pattern(arm.Pattern, null);
        if (arm.WhenClause is { } when && pattern is not null)
            pattern = new OpaqueExpression([pattern, Expression(when.Condition)], Locations.Of(arm.WhenClause));
        return new SwitchArm(pattern, Expression(arm.Expression), Locations.Of(arm));
    }

    private LambdaExpression Lambda(AnonymousFunctionExpressionSyntax lambda, SourceLocation location)
    {
        var parameters = lambda switch
        {
            SimpleLambdaExpressionSyntax simple => [Parameter(simple.Parameter)],
            ParenthesizedLambdaExpressionSyntax parenthesized => Parameters(parenthesized.ParameterList),
            AnonymousMethodExpressionSyntax anonymous => Parameters(anonymous.ParameterList),
            _ => [],
        };
        var isVoid = model.GetSymbolInfo(lambda).Symbol is IMethodSymbol { ReturnsVoid: true };
        var body = lambda.Block is { } block ? Block(block) : ExpressionBody(lambda.ExpressionBody!, isVoid);
        return new LambdaExpression(parameters, body, location);
    }

    private IReadOnlyList<Abstractions.Ir.Expression> Arguments(BaseArgumentListSyntax list) =>
        [.. list.Arguments.Select(a => Expression(a.Expression))];

    // Member initializers configure a new object, so only their values matter; they are not writes to existing state.
    private IReadOnlyList<Abstractions.Ir.Expression> Initializers(InitializerExpressionSyntax? initializer) =>
        initializer is null ? [] : [.. initializer.Expressions.Select(e => Expression(e is AssignmentExpressionSyntax a ? a.Right : e))];

    private static TypeRef Unknown(SyntaxNode syntax) => new(syntax.ToString(), null, TypeRefKind.Unknown, true);
}

/// <summary>Source text of declarations, as spec/structure.md writes it into facts.</summary>
internal static class Syntax
{
    /// <summary>The text of a type with optional modifiers in front; runs of whitespace become one space.</summary>
    public static string Text(TypeSyntax type, IEnumerable<SyntaxToken>? modifiers = null)
    {
        var words = (modifiers ?? []).Select(m => m.ValueText).Append(type.ToString());
        return string.Join(' ', string.Join(' ', words).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
    }
}
