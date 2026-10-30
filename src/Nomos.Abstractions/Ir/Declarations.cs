namespace Nomos.Abstractions.Ir;

/// <summary>A span in a source file. <see cref="FilePath"/> is relative to the analysis root and uses forward slashes.</summary>
/// <param name="FilePath">Relative file path.</param>
/// <param name="StartLine">1-based first line.</param>
/// <param name="StartColumn">1-based first column.</param>
/// <param name="EndLine">1-based last line.</param>
/// <param name="EndColumn">1-based last column.</param>
public readonly record struct SourceLocation(string FilePath, int StartLine, int StartColumn, int EndLine, int EndColumn)
{
    /// <summary>A location for synthesized nodes that have no source.</summary>
    public static SourceLocation None { get; } = new(string.Empty, 0, 0, 0, 0);

    /// <summary>Gets whether this location points to real source text.</summary>
    public bool IsKnown => StartLine > 0;

    /// <summary>Gets the number of lines covered by the span.</summary>
    public int LineSpan => IsKnown ? EndLine - StartLine + 1 : 0;
}

/// <summary>Member or type accessibility, normalized across languages.</summary>
public enum Visibility
{
    /// <summary>Accessible only from the declaring type.</summary>
    Private,
    /// <summary>Accessible from the declaring type and derived types.</summary>
    Protected,
    /// <summary>Accessible from the declaring package or assembly.</summary>
    Internal,
    /// <summary>Accessible from everywhere.</summary>
    Public,
}

/// <summary>Declaration modifiers, normalized across languages.</summary>
[Flags]
public enum Modifiers
{
    /// <summary>No modifiers.</summary>
    None = 0,
    /// <summary>Belongs to the type rather than an instance.</summary>
    Static = 1,
    /// <summary>Has no implementation here.</summary>
    Abstract = 2,
    /// <summary>May be overridden.</summary>
    Virtual = 4,
    /// <summary>Overrides a base member.</summary>
    Override = 8,
    /// <summary>Cannot be derived from or overridden.</summary>
    Sealed = 16,
    /// <summary>Asynchronous callable.</summary>
    Async = 32,
    /// <summary>Declaration is split over several parts.</summary>
    Partial = 64,
    /// <summary>Extension method or equivalent.</summary>
    Extension = 128,
    /// <summary>Implemented outside of the language (extern/native).</summary>
    Extern = 256,
}

/// <summary>Coarse classification of a referenced type.</summary>
public enum TypeRefKind
{
    /// <summary>Could not be determined.</summary>
    Unknown,
    /// <summary>Reference class.</summary>
    Class,
    /// <summary>Interface or trait.</summary>
    Interface,
    /// <summary>Value type or struct.</summary>
    Struct,
    /// <summary>Enumeration.</summary>
    Enum,
    /// <summary>Function-valued type (delegate, function pointer, lambda type).</summary>
    Function,
    /// <summary>Generic type parameter.</summary>
    TypeParameter,
    /// <summary>Array.</summary>
    Array,
    /// <summary>Tuple.</summary>
    Tuple,
    /// <summary>Built-in primitive, including strings.</summary>
    Primitive,
}

/// <summary>A reference to a type.</summary>
/// <param name="Name">Display name as it would appear in the source language.</param>
/// <param name="Id">Stable identifier; equals <see cref="TypeDecl.Id"/> for types declared in the project. Null when unresolved.</param>
/// <param name="Kind">Classification.</param>
/// <param name="IsExternal">True when the type is declared outside of the analyzed sources.</param>
public sealed record TypeRef(string Name, string? Id, TypeRefKind Kind, bool IsExternal)
{
    /// <summary>Gets generic arguments or array element type.</summary>
    public IReadOnlyList<TypeRef> TypeArguments { get; init; } = [];

    /// <summary>Gets whether the name was resolved semantically.</summary>
    public bool IsResolved => Id is not null;

    /// <summary>Gets the name without generic arguments or namespace qualification.</summary>
    public string SimpleName
    {
        get
        {
            var name = Name;
            var generic = name.IndexOf('<');
            if (generic >= 0) name = name[..generic];
            var dot = name.LastIndexOf('.');
            return dot >= 0 ? name[(dot + 1)..] : name;
        }
    }
}

/// <summary>Kinds of declared types.</summary>
public enum TypeKind
{
    /// <summary>Class.</summary>
    Class,
    /// <summary>Interface, protocol or trait.</summary>
    Interface,
    /// <summary>Value type.</summary>
    Struct,
    /// <summary>Immutable-by-convention data record.</summary>
    Record,
    /// <summary>Enumeration.</summary>
    Enum,
    /// <summary>Named function type.</summary>
    Delegate,
}

/// <summary>A language attribute, annotation or decorator on a declaration.</summary>
/// <param name="Name">Simple name without the "Attribute" suffix.</param>
/// <param name="Arguments">Literal argument values, in order; non-literal arguments are empty strings.</param>
/// <param name="Location">Source location.</param>
public sealed record AttributeInfo(string Name, IReadOnlyList<string> Arguments, SourceLocation Location);

/// <summary>A parameter of a callable.</summary>
/// <param name="Name">Parameter name.</param>
/// <param name="Type">Declared type, if any.</param>
/// <param name="Location">Source location.</param>
public sealed record Parameter(string Name, TypeRef? Type, SourceLocation Location)
{
    /// <summary>Gets whether the callee may rebind the caller's variable (ref/out/inout).</summary>
    public bool IsByReference { get; init; }

    /// <summary>Gets whether the parameter has a default value.</summary>
    public bool HasDefault { get; init; }
}

/// <summary>A field, constant or module-level variable.</summary>
/// <param name="Name">Field name.</param>
/// <param name="Type">Declared type.</param>
/// <param name="Visibility">Accessibility.</param>
/// <param name="Location">Source location.</param>
public sealed record FieldDecl(string Name, TypeRef? Type, Visibility Visibility, SourceLocation Location)
{
    /// <summary>Gets the stable identifier ("Type.Field").</summary>
    public required string Id { get; init; }

    /// <summary>Gets whether the field is shared across instances.</summary>
    public bool IsStatic { get; init; }

    /// <summary>Gets whether the field cannot be reassigned after construction.</summary>
    public bool IsReadOnly { get; init; }

    /// <summary>Gets whether this is a compile-time constant.</summary>
    public bool IsConstant { get; init; }

    /// <summary>Gets the initializer expression, if any.</summary>
    public Expression? Initializer { get; init; }
}

/// <summary>A property or accessor pair.</summary>
/// <param name="Name">Property name.</param>
/// <param name="Type">Declared type.</param>
/// <param name="Visibility">Accessibility of the property.</param>
/// <param name="Location">Source location.</param>
public sealed record PropertyDecl(string Name, TypeRef? Type, Visibility Visibility, SourceLocation Location)
{
    /// <summary>Gets the stable identifier ("Type.Property").</summary>
    public required string Id { get; init; }

    /// <summary>Gets whether the property has a getter.</summary>
    public bool HasGetter { get; init; }

    /// <summary>Gets the setter accessibility, or null when there is no regular setter.</summary>
    public Visibility? SetterVisibility { get; init; }

    /// <summary>Gets whether the setter only works at initialization.</summary>
    public bool IsInitOnly { get; init; }

    /// <summary>Gets whether storage is compiler-generated.</summary>
    public bool IsAuto { get; init; }

    /// <summary>Gets whether the property is shared across instances.</summary>
    public bool IsStatic { get; init; }

    /// <summary>Gets declaration modifiers (abstract, virtual, override).</summary>
    public Modifiers Modifiers { get; init; }

    /// <summary>Gets the initializer expression, if any.</summary>
    public Expression? Initializer { get; init; }
}

/// <summary>An event or signal a type publishes.</summary>
/// <param name="Name">Event name.</param>
/// <param name="Type">Handler type.</param>
/// <param name="Visibility">Accessibility.</param>
/// <param name="Location">Source location.</param>
public sealed record EventDecl(string Name, TypeRef? Type, Visibility Visibility, SourceLocation Location);

/// <summary>Kinds of callables.</summary>
public enum CallableKind
{
    /// <summary>Instance or static method.</summary>
    Method,
    /// <summary>Constructor.</summary>
    Constructor,
    /// <summary>Destructor or finalizer.</summary>
    Destructor,
    /// <summary>Free function, including top-level programs.</summary>
    Function,
    /// <summary>Property accessor with an explicit body.</summary>
    Accessor,
    /// <summary>Operator overload.</summary>
    Operator,
    /// <summary>Function declared within another callable.</summary>
    LocalFunction,
}

/// <summary>A unit of executable code.</summary>
public sealed record Callable(SourceLocation Location) : IrNode(Location)
{
    /// <summary>Gets the stable identifier ("Type.Method(int)").</summary>
    public required string Id { get; init; }

    /// <summary>Gets the simple name.</summary>
    public required string Name { get; init; }

    /// <summary>Gets the kind of callable.</summary>
    public required CallableKind Kind { get; init; }

    /// <summary>Gets the accessibility.</summary>
    public Visibility Visibility { get; init; }

    /// <summary>Gets declaration modifiers.</summary>
    public Modifiers Modifiers { get; init; }

    /// <summary>Gets the parameters.</summary>
    public IReadOnlyList<Parameter> Parameters { get; init; } = [];

    /// <summary>Gets the return type; null when void-like.</summary>
    public TypeRef? ReturnType { get; init; }

    /// <summary>Gets the body; null when abstract or extern.</summary>
    public BlockStatement? Body { get; init; }

    /// <summary>Gets the declared attributes.</summary>
    public IReadOnlyList<AttributeInfo> Attributes { get; init; } = [];

    /// <summary>Gets the identifier of the type that declares this callable; null for free functions.</summary>
    public string? DeclaringTypeId { get; init; }

    /// <summary>Gets the identifiers of the interface or base members this callable implements.</summary>
    public IReadOnlyList<string> Implements { get; init; } = [];

    /// <summary>Gets whether a documentation comment is attached.</summary>
    public bool HasDocumentation { get; init; }

    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => Body is null ? [] : [Body];

    /// <summary>Gets whether a modifier is set.</summary>
    /// <param name="modifier">The modifier to test.</param>
    public bool Has(Modifiers modifier) => (Modifiers & modifier) != 0;
}

/// <summary>Relation that caused a dependency between two types.</summary>
public enum DependencyKind
{
    /// <summary>Base class.</summary>
    Inheritance,
    /// <summary>Implemented interface.</summary>
    Implementation,
    /// <summary>Field, property or event type.</summary>
    Member,
    /// <summary>Parameter or return type.</summary>
    Signature,
    /// <summary>Local variable, cast or type test.</summary>
    Usage,
    /// <summary>Instantiation.</summary>
    Creation,
    /// <summary>Static member access or method call.</summary>
    Invocation,
    /// <summary>Attribute or annotation.</summary>
    Annotation,
}

/// <summary>A directed dependency from a declared type to another type.</summary>
/// <param name="SourceTypeId">Identifier of the dependent type.</param>
/// <param name="TargetTypeId">Identifier of the type depended upon.</param>
/// <param name="Kind">Relation kind.</param>
/// <param name="IsExternal">True when the target is outside the analyzed sources.</param>
/// <param name="Location">Where the dependency occurs.</param>
public sealed record Dependency(string SourceTypeId, string TargetTypeId, DependencyKind Kind, bool IsExternal, SourceLocation Location);

/// <summary>A type declaration, merged over all of its partial parts.</summary>
public sealed record TypeDecl(SourceLocation Location) : IrNode(Location)
{
    /// <summary>Gets the stable fully qualified identifier.</summary>
    public required string Id { get; init; }

    /// <summary>Gets the simple name.</summary>
    public required string Name { get; init; }

    /// <summary>Gets the kind of type.</summary>
    public required TypeKind Kind { get; init; }

    /// <summary>Gets the accessibility.</summary>
    public Visibility Visibility { get; init; }

    /// <summary>Gets declaration modifiers.</summary>
    public Modifiers Modifiers { get; init; }

    /// <summary>Gets the name of the owning module.</summary>
    public required string ModuleName { get; init; }

    /// <summary>Gets the base type; null when there is no explicit base in the project sense.</summary>
    public TypeRef? BaseType { get; init; }

    /// <summary>Gets directly implemented interfaces.</summary>
    public IReadOnlyList<TypeRef> Interfaces { get; init; } = [];

    /// <summary>Gets the number of inherited classes above this one, including external ones.</summary>
    public int InheritanceDepth { get; init; }

    /// <summary>Gets the fields.</summary>
    public IReadOnlyList<FieldDecl> Fields { get; init; } = [];

    /// <summary>Gets the properties.</summary>
    public IReadOnlyList<PropertyDecl> Properties { get; init; } = [];

    /// <summary>Gets the events.</summary>
    public IReadOnlyList<EventDecl> Events { get; init; } = [];

    /// <summary>Gets the callables: methods, constructors, accessors with bodies, operators.</summary>
    public IReadOnlyList<Callable> Callables { get; init; } = [];

    /// <summary>Gets directly nested types.</summary>
    public IReadOnlyList<TypeDecl> NestedTypes { get; init; } = [];

    /// <summary>Gets the declared attributes.</summary>
    public IReadOnlyList<AttributeInfo> Attributes { get; init; } = [];

    /// <summary>Gets the outgoing dependencies.</summary>
    public IReadOnlyList<Dependency> Dependencies { get; init; } = [];

    /// <summary>Gets the number of source lines over all partial parts.</summary>
    public int LineCount { get; init; }

    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [.. Callables, .. NestedTypes];

    /// <summary>Gets whether a modifier is set.</summary>
    /// <param name="modifier">The modifier to test.</param>
    public bool Has(Modifiers modifier) => (Modifiers & modifier) != 0;

    /// <summary>Gets whether the type cannot be instantiated directly.</summary>
    public bool IsAbstract => Kind == TypeKind.Interface || Has(Modifiers.Abstract);

    /// <summary>Gets this type followed by all nested types, recursively.</summary>
    public IEnumerable<TypeDecl> SelfAndNested()
    {
        yield return this;
        foreach (var nested in NestedTypes)
            foreach (var type in nested.SelfAndNested())
                yield return type;
    }
}

/// <summary>A cohesive group of declarations: namespace, package or source module, as defined by the adapter.</summary>
public sealed record ModuleDecl(string Name, string Language)
{
    /// <summary>Gets top-level types.</summary>
    public IReadOnlyList<TypeDecl> Types { get; init; } = [];

    /// <summary>Gets free functions.</summary>
    public IReadOnlyList<Callable> Functions { get; init; } = [];

    /// <summary>Gets module-level variables.</summary>
    public IReadOnlyList<FieldDecl> Globals { get; init; } = [];

    /// <summary>Gets the lines of code attributed to this module.</summary>
    public int LinesOfCode { get; init; }

    /// <summary>Gets all types of the module, nested ones included.</summary>
    public IEnumerable<TypeDecl> AllTypes => Types.SelectMany(t => t.SelfAndNested());

    /// <summary>Gets all callables of the module: free functions and members of all types.</summary>
    public IEnumerable<Callable> AllCallables => Functions.Concat(AllTypes.SelectMany(t => t.Callables));
}

/// <summary>A comment found in a source file.</summary>
/// <param name="Text">Raw comment text, delimiters included.</param>
/// <param name="Location">Source location.</param>
/// <param name="IsDocumentation">True for API documentation comments.</param>
public sealed record CommentInfo(string Text, SourceLocation Location, bool IsDocumentation);

/// <summary>Lexical classes used by token-level analysis.</summary>
public enum SourceTokenKind
{
    /// <summary>Reserved word.</summary>
    Keyword,
    /// <summary>Identifier.</summary>
    Identifier,
    /// <summary>Literal value.</summary>
    Literal,
    /// <summary>Operator or punctuation.</summary>
    Symbol,
}

/// <summary>A lexical token.</summary>
/// <param name="Kind">Lexical class.</param>
/// <param name="Text">Token text.</param>
/// <param name="Line">1-based line.</param>
public readonly record struct SourceToken(SourceTokenKind Kind, string Text, int Line);

/// <summary>A parsed source file with its lexical information.</summary>
/// <param name="Path">Path relative to the analysis root, with forward slashes.</param>
/// <param name="Language">Language identifier.</param>
/// <param name="Text">Full source text.</param>
public sealed record SourceFile(string Path, string Language, string Text)
{
    private readonly Lazy<string[]> _lines = new(() => Text.ReplaceLineEndings("\n").Split('\n'));

    /// <summary>Gets the tokens, excluding comments and whitespace.</summary>
    public IReadOnlyList<SourceToken> Tokens { get; init; } = [];

    /// <summary>Gets the comments.</summary>
    public IReadOnlyList<CommentInfo> Comments { get; init; } = [];

    /// <summary>Gets the source lines.</summary>
    public IReadOnlyList<string> Lines => _lines.Value;

    /// <summary>Extracts a short excerpt for a location.</summary>
    /// <param name="location">The location to excerpt.</param>
    /// <param name="maxLines">Maximum number of lines to take.</param>
    public string Excerpt(SourceLocation location, int maxLines = 4)
    {
        if (!location.IsKnown || location.StartLine > Lines.Count) return string.Empty;
        var end = Math.Min(Math.Min(location.EndLine, Lines.Count), location.StartLine + maxLines - 1);
        var taken = Lines.Skip(location.StartLine - 1).Take(end - location.StartLine + 1).ToList();
        var indent = taken.Where(l => l.Trim().Length > 0).Select(l => l.Length - l.TrimStart().Length).DefaultIfEmpty(0).Min();
        return string.Join('\n', taken.Select(l => l.Length >= indent ? l[indent..].TrimEnd() : l.TrimEnd()));
    }
}

/// <summary>The full language-independent model of the analyzed code.</summary>
public sealed class ProjectModel
{
    private readonly Lazy<Dictionary<string, TypeDecl>> _types;
    private readonly Lazy<Dictionary<string, Callable>> _callables;
    private readonly Lazy<Dictionary<string, SourceFile>> _files;
    private readonly Lazy<ILookup<string, TypeDecl>> _subtypes;

    /// <summary>Initializes a new instance.</summary>
    /// <param name="name">Project name.</param>
    /// <param name="modules">The modules.</param>
    /// <param name="files">The source files.</param>
    public ProjectModel(string name, IReadOnlyList<ModuleDecl> modules, IReadOnlyList<SourceFile> files)
    {
        Name = name;
        Modules = modules;
        Files = files;
        _types = new(() => AllTypes.GroupBy(t => t.Id).ToDictionary(g => g.Key, g => g.First()));
        _callables = new(() => Modules.SelectMany(m => m.AllCallables).GroupBy(c => c.Id).ToDictionary(g => g.Key, g => g.First()));
        _files = new(() => Files.GroupBy(f => f.Path).ToDictionary(g => g.Key, g => g.First()));
        _subtypes = new(() => AllTypes
            .SelectMany(t => t.Interfaces.Concat(t.BaseType is null ? [] : [t.BaseType]).Where(b => b.Id is not null).Select(b => (b.Id!, t)))
            .ToLookup(p => p.Item1, p => p.t));
    }

    /// <summary>Gets the project name.</summary>
    public string Name { get; }

    /// <summary>Gets the modules.</summary>
    public IReadOnlyList<ModuleDecl> Modules { get; }

    /// <summary>Gets the source files.</summary>
    public IReadOnlyList<SourceFile> Files { get; }

    /// <summary>Gets all types, nested included.</summary>
    public IEnumerable<TypeDecl> AllTypes => Modules.SelectMany(m => m.AllTypes);

    /// <summary>Finds a project type by identifier.</summary>
    /// <param name="id">Type identifier.</param>
    public TypeDecl? FindType(string? id) => id is not null && _types.Value.TryGetValue(id, out var type) ? type : null;

    /// <summary>Finds a callable by identifier.</summary>
    /// <param name="id">Callable identifier.</param>
    public Callable? FindCallable(string? id) => id is not null && _callables.Value.TryGetValue(id, out var callable) ? callable : null;

    /// <summary>Finds a source file by relative path.</summary>
    /// <param name="path">Relative path.</param>
    public SourceFile? FindFile(string path) => _files.Value.GetValueOrDefault(path);

    /// <summary>Gets project types that directly extend or implement a type.</summary>
    /// <param name="id">Type identifier.</param>
    public IEnumerable<TypeDecl> DirectSubtypes(string id) => _subtypes.Value[id];
}
