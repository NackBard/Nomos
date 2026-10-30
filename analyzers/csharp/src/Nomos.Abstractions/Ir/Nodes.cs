namespace Nomos.Abstractions.Ir;

/// <summary>Base of all executable IR nodes.</summary>
/// <param name="Location">Source location.</param>
public abstract record IrNode(SourceLocation Location)
{
    /// <summary>Gets the direct child nodes in source order.</summary>
    public abstract IEnumerable<IrNode> Children { get; }

    /// <summary>Gets this node and all of its descendants, depth first.</summary>
    public IEnumerable<IrNode> DescendantsAndSelf()
    {
        var stack = new Stack<IrNode>();
        stack.Push(this);
        while (stack.Count > 0)
        {
            var node = stack.Pop();
            yield return node;
            foreach (var child in node.Children.Reverse()) stack.Push(child);
        }
    }
}

/// <summary>Base of statements.</summary>
/// <param name="Location">Source location.</param>
public abstract record Statement(SourceLocation Location) : IrNode(Location);

/// <summary>Sequence of statements.</summary>
/// <param name="Statements">The statements.</param>
/// <param name="Location">Source location.</param>
public sealed record BlockStatement(IReadOnlyList<Statement> Statements, SourceLocation Location) : Statement(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => Statements;
}

/// <summary>An expression evaluated for its effect.</summary>
/// <param name="Expression">The expression.</param>
/// <param name="Location">Source location.</param>
public sealed record ExpressionStatement(Expression Expression, SourceLocation Location) : Statement(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [Expression];
}

/// <summary>Declaration of one local variable.</summary>
/// <param name="Name">Variable name.</param>
/// <param name="Type">Variable type.</param>
/// <param name="Initializer">Initializer, if any.</param>
/// <param name="IsMutable">False for constants and single-assignment bindings.</param>
/// <param name="Location">Source location.</param>
public sealed record LocalDeclaration(string Name, TypeRef? Type, Expression? Initializer, bool IsMutable, SourceLocation Location) : Statement(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => Initializer is null ? [] : [Initializer];
}

/// <summary>Conditional branch.</summary>
/// <param name="Condition">Condition.</param>
/// <param name="Then">Then branch.</param>
/// <param name="Else">Else branch, if any.</param>
/// <param name="Location">Source location.</param>
public sealed record IfStatement(Expression Condition, Statement Then, Statement? Else, SourceLocation Location) : Statement(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => Else is null ? [Condition, Then] : [Condition, Then, Else];
}

/// <summary>Kinds of loops.</summary>
public enum LoopKind
{
    /// <summary>Counter loop with init, condition and update.</summary>
    For,
    /// <summary>Iteration over a sequence.</summary>
    ForEach,
    /// <summary>Pre-condition loop.</summary>
    While,
    /// <summary>Post-condition loop.</summary>
    DoWhile,
}

/// <summary>Any loop.</summary>
/// <param name="Kind">Loop kind.</param>
/// <param name="Body">Loop body.</param>
/// <param name="Location">Source location.</param>
public sealed record LoopStatement(LoopKind Kind, Statement Body, SourceLocation Location) : Statement(Location)
{
    /// <summary>Gets the initializers of a counter loop.</summary>
    public IReadOnlyList<Statement> Initializers { get; init; } = [];

    /// <summary>Gets the loop condition.</summary>
    public Expression? Condition { get; init; }

    /// <summary>Gets the update expressions of a counter loop.</summary>
    public IReadOnlyList<Expression> Updates { get; init; } = [];

    /// <summary>Gets the iterated sequence of a for-each loop.</summary>
    public Expression? Iterable { get; init; }

    /// <summary>Gets the iteration variable of a for-each loop.</summary>
    public string? Variable { get; init; }

    /// <inheritdoc />
    public override IEnumerable<IrNode> Children
    {
        get
        {
            foreach (var init in Initializers) yield return init;
            if (Iterable is not null) yield return Iterable;
            if (Condition is not null) yield return Condition;
            foreach (var update in Updates) yield return update;
            yield return Body;
        }
    }
}

/// <summary>One section of a multi-way branch.</summary>
/// <param name="Labels">Case labels; empty for the default section.</param>
/// <param name="Statements">Section body.</param>
/// <param name="Location">Source location.</param>
public sealed record SwitchSection(IReadOnlyList<Expression> Labels, IReadOnlyList<Statement> Statements, SourceLocation Location) : IrNode(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [.. Labels, .. Statements];
}

/// <summary>Multi-way branch.</summary>
/// <param name="Subject">Discriminator.</param>
/// <param name="Sections">Sections.</param>
/// <param name="Location">Source location.</param>
public sealed record SwitchStatement(Expression Subject, IReadOnlyList<SwitchSection> Sections, SourceLocation Location) : Statement(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [Subject, .. Sections];
}

/// <summary>An exception handler.</summary>
/// <param name="ExceptionType">Caught type; null for catch-all.</param>
/// <param name="Filter">Filter expression.</param>
/// <param name="Body">Handler body.</param>
/// <param name="Location">Source location.</param>
public sealed record CatchClause(TypeRef? ExceptionType, Expression? Filter, BlockStatement Body, SourceLocation Location) : IrNode(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => Filter is null ? [Body] : [Filter, Body];
}

/// <summary>Exception-handling statement.</summary>
/// <param name="Body">Protected block.</param>
/// <param name="Catches">Handlers.</param>
/// <param name="Finally">Finally block, if any.</param>
/// <param name="Location">Source location.</param>
public sealed record TryStatement(BlockStatement Body, IReadOnlyList<CatchClause> Catches, BlockStatement? Finally, SourceLocation Location) : Statement(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => Finally is null ? [Body, .. Catches] : [Body, .. Catches, Finally];
}

/// <summary>Function return.</summary>
/// <param name="Value">Returned value, if any.</param>
/// <param name="Location">Source location.</param>
public sealed record ReturnStatement(Expression? Value, SourceLocation Location) : Statement(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => Value is null ? [] : [Value];
}

/// <summary>Raises an exception.</summary>
/// <param name="Value">Thrown value; null for a rethrow.</param>
/// <param name="Location">Source location.</param>
public sealed record ThrowStatement(Expression? Value, SourceLocation Location) : Statement(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => Value is null ? [] : [Value];
}

/// <summary>Leaves the enclosing loop or switch.</summary>
/// <param name="Location">Source location.</param>
public sealed record BreakStatement(SourceLocation Location) : Statement(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [];
}

/// <summary>Starts the next loop iteration.</summary>
/// <param name="Location">Source location.</param>
public sealed record ContinueStatement(SourceLocation Location) : Statement(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [];
}

/// <summary>Unconditional jump.</summary>
/// <param name="Label">Jump target.</param>
/// <param name="Location">Source location.</param>
public sealed record GotoStatement(string Label, SourceLocation Location) : Statement(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [];
}

/// <summary>A labeled statement.</summary>
/// <param name="Label">Label name.</param>
/// <param name="Inner">The labeled statement.</param>
/// <param name="Location">Source location.</param>
public sealed record LabeledStatement(string Label, Statement Inner, SourceLocation Location) : Statement(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [Inner];
}

/// <summary>Produces the next element of a generator.</summary>
/// <param name="Value">Yielded value; null ends the sequence.</param>
/// <param name="Location">Source location.</param>
public sealed record YieldStatement(Expression? Value, SourceLocation Location) : Statement(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => Value is null ? [] : [Value];
}

/// <summary>A block guarded by a resource or lock.</summary>
/// <param name="Keyword">Language keyword, for example "lock" or "using".</param>
/// <param name="Resource">Guarded resource.</param>
/// <param name="Body">Guarded body.</param>
/// <param name="Location">Source location.</param>
public sealed record ScopedStatement(string Keyword, Expression? Resource, Statement Body, SourceLocation Location) : Statement(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => Resource is null ? [Body] : [Resource, Body];
}

/// <summary>A function declared in a body.</summary>
/// <param name="Function">The nested callable.</param>
/// <param name="Location">Source location.</param>
public sealed record LocalFunctionStatement(Callable Function, SourceLocation Location) : Statement(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [Function];
}

/// <summary>A statement with no specific IR form.</summary>
/// <param name="Inner">Nested nodes that are still visible to analysis.</param>
/// <param name="Location">Source location.</param>
public sealed record OpaqueStatement(IReadOnlyList<IrNode> Inner, SourceLocation Location) : Statement(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => Inner;
}

/// <summary>Base of expressions.</summary>
/// <param name="Location">Source location.</param>
public abstract record Expression(SourceLocation Location) : IrNode(Location)
{
    /// <summary>Gets the static type of the expression, when known.</summary>
    public TypeRef? Type { get; init; }
}

/// <summary>Kinds of symbols a name can bind to.</summary>
public enum SymbolKind
{
    /// <summary>Unresolved.</summary>
    Unknown,
    /// <summary>Local variable.</summary>
    Local,
    /// <summary>Parameter.</summary>
    Parameter,
    /// <summary>Field.</summary>
    Field,
    /// <summary>Property.</summary>
    Property,
    /// <summary>Event.</summary>
    Event,
    /// <summary>Method or function.</summary>
    Callable,
    /// <summary>Type.</summary>
    Type,
    /// <summary>Namespace or module.</summary>
    Namespace,
    /// <summary>The current instance.</summary>
    This,
    /// <summary>The base part of the current instance.</summary>
    Base,
}

/// <summary>What a name refers to.</summary>
/// <param name="Kind">Symbol kind.</param>
/// <param name="Name">Simple name.</param>
public sealed record SymbolRef(SymbolKind Kind, string Name)
{
    /// <summary>Gets the stable identifier: a member, callable or type id; null when unresolved or local.</summary>
    public string? Id { get; init; }

    /// <summary>Gets the identifier of the declaring type.</summary>
    public string? DeclaringTypeId { get; init; }

    /// <summary>Gets whether the symbol is a static member.</summary>
    public bool IsStatic { get; init; }

    /// <summary>Gets whether the symbol is declared outside of the analyzed sources.</summary>
    public bool IsExternal { get; init; }
}

/// <summary>Kinds of literals.</summary>
public enum LiteralKind
{
    /// <summary>Numeric.</summary>
    Number,
    /// <summary>Text.</summary>
    String,
    /// <summary>Boolean.</summary>
    Boolean,
    /// <summary>Null, none or nil.</summary>
    Null,
    /// <summary>Other.</summary>
    Other,
}

/// <summary>A literal value.</summary>
/// <param name="Kind">Literal kind.</param>
/// <param name="Value">Value text; strings are unquoted.</param>
/// <param name="Location">Source location.</param>
public sealed record LiteralExpression(LiteralKind Kind, string? Value, SourceLocation Location) : Expression(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [];
}

/// <summary>A simple name.</summary>
/// <param name="Symbol">Bound symbol.</param>
/// <param name="Location">Source location.</param>
public sealed record NameExpression(SymbolRef Symbol, SourceLocation Location) : Expression(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [];
}

/// <summary>Member access.</summary>
/// <param name="Target">Receiver.</param>
/// <param name="Member">Bound member.</param>
/// <param name="Location">Source location.</param>
public sealed record MemberAccessExpression(Expression Target, SymbolRef Member, SourceLocation Location) : Expression(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [Target];
}

/// <summary>A call.</summary>
/// <param name="Callee">Callee expression.</param>
/// <param name="Arguments">Arguments.</param>
/// <param name="Target">Bound callable.</param>
/// <param name="Location">Source location.</param>
public sealed record InvocationExpression(Expression Callee, IReadOnlyList<Expression> Arguments, SymbolRef Target, SourceLocation Location) : Expression(Location)
{
    /// <summary>Gets the receiver of a member call; null for a simple name call.</summary>
    public Expression? Receiver => (Callee as MemberAccessExpression)?.Target;

    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [Callee, .. Arguments];
}

/// <summary>Instantiation.</summary>
/// <param name="CreatedType">Created type.</param>
/// <param name="Arguments">Constructor arguments.</param>
/// <param name="Initializers">Initializer expressions.</param>
/// <param name="Location">Source location.</param>
public sealed record ObjectCreationExpression(TypeRef CreatedType, IReadOnlyList<Expression> Arguments, IReadOnlyList<Expression> Initializers, SourceLocation Location) : Expression(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [.. Arguments, .. Initializers];
}

/// <summary>Assignment, compound ones included.</summary>
/// <param name="Target">Assigned target.</param>
/// <param name="Value">Assigned value.</param>
/// <param name="Operator">Operator text, for example "=" or "+=".</param>
/// <param name="Location">Source location.</param>
public sealed record AssignmentExpression(Expression Target, Expression Value, string Operator, SourceLocation Location) : Expression(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [Target, Value];
}

/// <summary>Binary operation.</summary>
/// <param name="Operator">Operator text.</param>
/// <param name="Left">Left operand.</param>
/// <param name="Right">Right operand.</param>
/// <param name="Location">Source location.</param>
public sealed record BinaryExpression(string Operator, Expression Left, Expression Right, SourceLocation Location) : Expression(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [Left, Right];
}

/// <summary>Unary operation.</summary>
/// <param name="Operator">Operator text.</param>
/// <param name="Operand">Operand.</param>
/// <param name="IsMutation">True for increments and decrements.</param>
/// <param name="Location">Source location.</param>
public sealed record UnaryExpression(string Operator, Expression Operand, bool IsMutation, SourceLocation Location) : Expression(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [Operand];
}

/// <summary>Ternary conditional.</summary>
/// <param name="Condition">Condition.</param>
/// <param name="WhenTrue">True branch.</param>
/// <param name="WhenFalse">False branch.</param>
/// <param name="Location">Source location.</param>
public sealed record ConditionalExpression(Expression Condition, Expression WhenTrue, Expression WhenFalse, SourceLocation Location) : Expression(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [Condition, WhenTrue, WhenFalse];
}

/// <summary>Anonymous function.</summary>
/// <param name="Parameters">Parameters.</param>
/// <param name="Body">Body.</param>
/// <param name="Location">Source location.</param>
public sealed record LambdaExpression(IReadOnlyList<Parameter> Parameters, BlockStatement Body, SourceLocation Location) : Expression(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [Body];
}

/// <summary>Collection or array literal.</summary>
/// <param name="Elements">Elements.</param>
/// <param name="Location">Source location.</param>
public sealed record CollectionExpression(IReadOnlyList<Expression> Elements, SourceLocation Location) : Expression(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => Elements;
}

/// <summary>Indexer access.</summary>
/// <param name="Target">Indexed value.</param>
/// <param name="Indices">Indices.</param>
/// <param name="Location">Source location.</param>
public sealed record ElementAccessExpression(Expression Target, IReadOnlyList<Expression> Indices, SourceLocation Location) : Expression(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [Target, .. Indices];
}

/// <summary>Explicit conversion.</summary>
/// <param name="TargetType">Target type.</param>
/// <param name="Operand">Converted value.</param>
/// <param name="Location">Source location.</param>
public sealed record CastExpression(TypeRef TargetType, Expression Operand, SourceLocation Location) : Expression(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [Operand];
}

/// <summary>Runtime type test or pattern match.</summary>
/// <param name="Operand">Tested value.</param>
/// <param name="TestedType">Tested type, when the pattern names one.</param>
/// <param name="Location">Source location.</param>
public sealed record TypeTestExpression(Expression Operand, TypeRef? TestedType, SourceLocation Location) : Expression(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [Operand];
}

/// <summary>Suspension point of an asynchronous call.</summary>
/// <param name="Operand">Awaited value.</param>
/// <param name="Location">Source location.</param>
public sealed record AwaitExpression(Expression Operand, SourceLocation Location) : Expression(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [Operand];
}

/// <summary>String with embedded expressions.</summary>
/// <param name="Parts">Text parts as literals, interleaved with holes.</param>
/// <param name="Location">Source location.</param>
public sealed record InterpolatedStringExpression(IReadOnlyList<Expression> Parts, SourceLocation Location) : Expression(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => Parts;
}

/// <summary>One arm of a switch expression.</summary>
/// <param name="Pattern">Pattern, simplified to an expression.</param>
/// <param name="Value">Arm value.</param>
/// <param name="Location">Source location.</param>
public sealed record SwitchArm(Expression? Pattern, Expression Value, SourceLocation Location) : IrNode(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => Pattern is null ? [Value] : [Pattern, Value];
}

/// <summary>Multi-way branch in expression form.</summary>
/// <param name="Subject">Discriminator.</param>
/// <param name="Arms">Arms.</param>
/// <param name="Location">Source location.</param>
public sealed record SwitchExpression(Expression Subject, IReadOnlyList<SwitchArm> Arms, SourceLocation Location) : Expression(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => [Subject, .. Arms];
}

/// <summary>An expression with no specific IR form.</summary>
/// <param name="Inner">Nested nodes that are still visible to analysis.</param>
/// <param name="Location">Source location.</param>
public sealed record OpaqueExpression(IReadOnlyList<IrNode> Inner, SourceLocation Location) : Expression(Location)
{
    /// <inheritdoc />
    public override IEnumerable<IrNode> Children => Inner;
}
