namespace Nomos.Analyzers.CleanCode;

/// <summary>Flags code that cannot run or is never used.</summary>
[Analyzer("CC007", Categories.CleanCode, Title = "Dead code", Severity = Severity.Minor, Paradigms = [Paradigms.ObjectOriented, Paradigms.Structural, Paradigms.Functional],
    Description = "Finds unreachable statements, unused locals, and private members nothing in the type refers to.")]
public sealed class DeadCodeAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var callable in context.Callables)
        {
            foreach (var statement in ControlFlow.UnreachableStatements(callable.Body))
                context.Report(Confidence.High, statement.Location, $"Unreachable code in {callable.Name}", "The preceding statement always leaves this block.", symbol: callable.Id);

            var flow = DataFlow.Analyze(callable.Body);
            foreach (var local in callable.Body.All<LocalDeclaration>().Where(l => !flow.LocalReads.Contains(l.Name)))
                context.Report(Confidence.Medium, local.Location, $"Local {local.Name} is never read", "No expression in the callable reads this variable; its initializer may still have side effects.", symbol: callable.Id);
        }

        foreach (var type in context.Types.Where(t => t.Kind != TypeKind.Enum && !t.Has(Modifiers.Partial)))
        {
            var referenced = Referenced(type);
            foreach (var callable in type.Callables.Where(c => c is { Visibility: Visibility.Private, Kind: CallableKind.Method, Implements.Count: 0, Attributes.Count: 0 } && c.Name != "Main" && !referenced.Contains(c.Id)))
                context.Report(Confidence.Medium, callable.Location, $"Private method {callable.Name} is never called", "Nothing in the declaring type refers to it; only reflection could reach it.", type.ModuleName, callable.Id);
            foreach (var field in type.Fields.Where(f => f is { Visibility: Visibility.Private, IsConstant: false } && !referenced.Contains(f.Id)))
                context.Report(Confidence.Medium, field.Location, $"Private field {field.Name} is never used", "Nothing in the declaring type refers to it; only reflection could reach it.", type.ModuleName, field.Id);
        }
    }

    private static HashSet<string> Referenced(TypeDecl type)
    {
        var ids = new HashSet<string>();
        var nested = type.SelfAndNested().ToList();
        var initializers = nested.SelectMany(t => t.Fields.Select(f => f.Initializer).Concat(t.Properties.Select(p => p.Initializer))).OfType<IrNode>();
        var roots = type.DescendantsAndSelf().Concat(initializers);
        foreach (var node in roots.SelectMany(r => r.DescendantsAndSelf()))
        {
            var id = node switch
            {
                NameExpression name => name.Symbol.Id,
                MemberAccessExpression access => access.Member.Id,
                InvocationExpression call => call.Target.Id,
                _ => null,
            };
            if (id is not null) ids.Add(id);
        }
        return ids;
    }
}

/// <summary>Flags handlers that swallow exceptions.</summary>
[Analyzer("CC009", Categories.CleanCode, Title = "Empty catch", Severity = Severity.Major, Paradigms = [Paradigms.ObjectOriented, Paradigms.Structural, Paradigms.Functional],
    Description = "A catch block with no statements and no comment silently discards the failure.")]
public sealed class EmptyCatchAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var callable in context.Callables)
        {
            foreach (var clause in callable.Body.All<CatchClause>().Where(c => c.Body.Statements.Count == 0))
            {
                var file = context.Model.FindFile(clause.Location.FilePath);
                var end = (clause.Location.EndLine, clause.Location.EndColumn);
                var explained = file?.Comments.Any(c => c.Location.StartLine >= clause.Location.StartLine && (c.Location.EndLine, c.Location.EndColumn).CompareTo(end) <= 0) == true;
                if (!explained)
                    context.Report(Confidence.High, clause.Location, $"Empty catch in {callable.Name}", "The exception disappears without handling, logging or a comment saying why that is safe.", symbol: callable.Id);
            }
        }
    }
}
