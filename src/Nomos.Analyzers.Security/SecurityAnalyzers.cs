using System.Text.RegularExpressions;

namespace Nomos.Analyzers.Security;

/// <summary>Flags secrets in source.</summary>
[Analyzer("SEC001", Categories.Security, Title = "Hardcoded secret (heuristic)", Severity = Severity.Major,
    Description = "Heuristic: string literals assigned to secret-like names, and literals with the shape of known credentials. Not a substitute for a secret scanner.")]
public sealed partial class HardcodedSecretAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var type in context.Types)
            foreach (var field in type.Fields)
                Check(context, field.Name, field.Initializer, field.Location, type.ModuleName, field.Id);

        foreach (var type in context.Types)
            foreach (var property in type.Properties)
                Check(context, property.Name, property.Initializer, property.Location, type.ModuleName, property.Id);

        foreach (var callable in context.Callables)
        {
            foreach (var local in callable.Body.All<LocalDeclaration>())
                Check(context, local.Name, local.Initializer, local.Location, null, callable.Id);
            foreach (var assignment in callable.Body.All<AssignmentExpression>())
            {
                var name = assignment.Target switch
                {
                    NameExpression n => n.Symbol.Name,
                    MemberAccessExpression m => m.Member.Name,
                    _ => string.Empty,
                };
                Check(context, name, assignment.Value, assignment.Location, null, callable.Id);
            }
        }
    }

    private static void Check(AnalysisContext context, string name, Expression? value, SourceLocation location, string? module, string symbol)
    {
        if (value is not LiteralExpression { Kind: LiteralKind.String, Value: { Length: >= 6 } text }) return;
        if (KnownCredential().IsMatch(text))
            context.Report(Confidence.High, location, $"{name} holds what looks like a real credential", "Heuristic: the literal matches the format of a known key or token. Rotate it if it is real, and load it from a secret store.", module, symbol, Severity.Critical);
        else if (SecretName().IsMatch(name) && !text.Contains(' ', StringComparison.Ordinal) && !text.Contains('{', StringComparison.Ordinal))
            context.Report(Confidence.Medium, location, $"{name} looks like a hardcoded secret", "Heuristic: the name suggests a secret and the value is a literal. It may be a placeholder or a non-secret value.", module, symbol);
    }

    [GeneratedRegex("password|passwd|pwd|secret|api_?key|apikey|access_?token|auth_?token|private_?key", RegexOptions.IgnoreCase)]
    private static partial Regex SecretName();

    [GeneratedRegex(@"AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{32,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,}")]
    private static partial Regex KnownCredential();
}

/// <summary>Flags dangerous deserializers.</summary>
[Analyzer("SEC002", Categories.Security, Title = "Insecure deserialization (heuristic)", Severity = Severity.Critical,
    Description = "Heuristic: use of formatters that instantiate arbitrary types from their input, or polymorphic type handling.")]
public sealed class InsecureDeserializationAnalyzer : AnalyzerBase
{
    private static readonly HashSet<string> Formatters = ["BinaryFormatter", "SoapFormatter", "NetDataContractSerializer", "LosFormatter", "ObjectStateFormatter"];

    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var callable in context.Callables)
        {
            foreach (var creation in callable.Body.All<ObjectCreationExpression>().Where(o => Formatters.Contains(o.CreatedType.SimpleName)))
                context.Report(Confidence.High, creation.Location, $"{creation.CreatedType.SimpleName} is unsafe with untrusted data", "Heuristic: this formatter can instantiate arbitrary types from its input; whether the input is trusted is not checked.", symbol: callable.Id);
            foreach (var access in callable.Body.All<MemberAccessExpression>().Where(a => a.Target is NameExpression { Symbol.Name: "TypeNameHandling" } && a.Member.Name != "None"))
                context.Report(Confidence.Medium, access.Location, $"TypeNameHandling.{access.Member.Name} enables polymorphic deserialization", "Heuristic: type names read from the payload allow gadget chains unless a binder restricts them.", symbol: callable.Id);
        }
    }
}

/// <summary>Flags SQL built from strings.</summary>
[Analyzer("SEC003", Categories.Security, Title = "SQL concatenation (heuristic)", Severity = Severity.Major,
    Description = "Heuristic: SQL-looking text concatenated or interpolated with non-constant values.")]
public sealed partial class SqlConcatenationAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var callable in context.Callables)
        {
            var inner = new HashSet<IrNode>(ReferenceEqualityComparer.Instance);
            foreach (var node in callable.Body.All<Expression>())
            {
                if (inner.Contains(node) || node is not (BinaryExpression { Operator: "+" } or InterpolatedStringExpression)) continue;
                var parts = Parts(node).ToList();
                foreach (var part in node.All<Expression>()) inner.Add(part);
                var text = string.Concat(parts.OfType<LiteralExpression>().Select(l => l.Value));
                var isDynamic = parts.Any(p => p is not LiteralExpression);
                if (isDynamic && Sql().IsMatch(text))
                    context.Report(Confidence.Medium, node.Location, "SQL built from non-constant values", "Heuristic: if any value comes from a user, this allows injection. Parameterized queries keep data out of the statement.", symbol: callable.Id);
            }
        }
    }

    private static IEnumerable<Expression> Parts(Expression expression) => expression switch
    {
        BinaryExpression { Operator: "+" } binary => Parts(binary.Left).Concat(Parts(binary.Right)),
        InterpolatedStringExpression interpolated => interpolated.Parts,
        _ => [expression],
    };

    [GeneratedRegex(@"\b(SELECT\s.+\sFROM|INSERT\s+INTO|UPDATE\s.+\sSET|DELETE\s+FROM|DROP\s+TABLE)\b", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex Sql();
}
