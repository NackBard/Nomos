using System.Text.RegularExpressions;
using System.Xml.Linq;
using Nomos.Abstractions;
using Nomos.Abstractions.Ir;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace Nomos.Languages.CSharp;

/// <summary>C# adapter over Roslyn. All sources form one compilation against the running .NET framework.</summary>
public sealed partial class CSharpLanguageAdapter : ILanguageAdapter, IProjectFileExpander
{
    private const string ImplicitUsings = """
        global using System;
        global using System.Collections.Generic;
        global using System.IO;
        global using System.Linq;
        global using System.Net.Http;
        global using System.Threading;
        global using System.Threading.Tasks;
        """;

    private static readonly Lazy<IReadOnlyList<MetadataReference>> FrameworkReferences = new(() =>
        [.. ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator)
            .Where(p => Path.GetFileName(p).StartsWith("System", StringComparison.Ordinal)
                || Path.GetFileName(p) is "mscorlib.dll" or "netstandard.dll")
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))]);

    /// <inheritdoc />
    public string Language => Abstractions.Languages.CSharp;

    /// <inheritdoc />
    public IReadOnlyList<string> FileExtensions { get; } = [".cs"];

    /// <inheritdoc />
    public IReadOnlyList<string> SupportedParadigms { get; } = [Abstractions.Paradigms.ObjectOriented, Abstractions.Paradigms.Functional, Abstractions.Paradigms.Structural];

    /// <inheritdoc />
    public IReadOnlyList<string> DefaultParadigms { get; } = [Abstractions.Paradigms.ObjectOriented, Abstractions.Paradigms.Structural];

    /// <inheritdoc />
    public Task<AdapterResult> LoadAsync(IReadOnlyList<SourceInput> sources, CancellationToken cancellationToken) =>
        Task.Run(() => Load(sources, cancellationToken), cancellationToken);

    private AdapterResult Load(IReadOnlyList<SourceInput> sources, CancellationToken cancellationToken)
    {
        var parseOptions = CSharpParseOptions.Default.WithLanguageVersion(LanguageVersion.Latest);
        var trees = sources.AsParallel().AsOrdered().WithCancellation(cancellationToken)
            .Select(s => CSharpSyntaxTree.ParseText(s.Text, parseOptions, s.Path, cancellationToken: cancellationToken)).ToList();

        // Implicit usings normally come from the project file, which is not evaluated here.
        var usings = CSharpSyntaxTree.ParseText(ImplicitUsings, parseOptions, "<implicit-usings>", cancellationToken: cancellationToken);
        var compilation = CSharpCompilation.Create("NomosAnalysis", [.. trees, usings], FrameworkReferences.Value,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, allowUnsafe: true));

        var builder = new IrBuilder(compilation, Language);
        foreach (var tree in trees)
        {
            cancellationToken.ThrowIfCancellationRequested();
            builder.AddTree(tree);
        }

        var diagnostics = new List<ToolDiagnostic>();
        var syntaxErrors = trees.Sum(t => t.GetDiagnostics(cancellationToken).Count(d => d.Severity == DiagnosticSeverity.Error));
        if (syntaxErrors > 0) diagnostics.Add(new(DiagnosticLevel.Warning, Language, $"{syntaxErrors} syntax error(s); affected code may be missing from the model."));
        var unresolved = compilation.GetDiagnostics(cancellationToken).Count(d => d.Id is "CS0246" or "CS0234");
        if (unresolved > 0) diagnostics.Add(new(DiagnosticLevel.Info, Language, $"{unresolved} unresolved type reference(s), usually from NuGet packages; those symbols use name-based fallbacks."));

        return new AdapterResult(builder.BuildModules(), [.. trees.Select(LexicalScanner.Scan).Select(f => f with { Language = Language })], diagnostics);
    }

    /// <inheritdoc />
    public bool CanExpand(string path) => Path.GetExtension(path).ToLowerInvariant() is ".sln" or ".slnx" or ".csproj";

    /// <inheritdoc />
    public IReadOnlyList<string> ExpandToDirectories(string path)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(path))!;
        var projects = Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".sln" => SlnProjectRegex().Matches(File.ReadAllText(path)).Select(m => m.Groups[1].Value),
            ".slnx" => XDocument.Load(path).Descendants("Project").Select(e => e.Attribute("Path")?.Value).OfType<string>(),
            _ => [Path.GetFileName(path)],
        };
        return [.. projects
            .Select(p => Path.GetFullPath(Path.Combine(directory, p.Replace('\\', Path.DirectorySeparatorChar))))
            .Select(p => Path.GetDirectoryName(p)!)
            .Where(Directory.Exists)
            .Distinct()];
    }

    [GeneratedRegex(@"Project\(""[^""]+""\)\s*=\s*""[^""]+"",\s*""([^""]+\.csproj)""")]
    private static partial Regex SlnProjectRegex();
}

internal static class LexicalScanner
{
    public static SourceFile Scan(SyntaxTree tree)
    {
        var root = tree.GetRoot();
        // Tokens the parser could not place (after a syntax error) are trivia, not tokens, but they are still code on their line.
        var skipped = root.DescendantTrivia(descendIntoTrivia: false)
            .Where(t => t.IsKind(SyntaxKind.SkippedTokensTrivia))
            .SelectMany(t => ((Microsoft.CodeAnalysis.CSharp.Syntax.SkippedTokensTriviaSyntax)t.GetStructure()!).Tokens);
        var tokens = root.DescendantTokens().Concat(skipped)
            .Where(token => !token.IsKind(SyntaxKind.EndOfFileToken))
            .OrderBy(token => token.SpanStart)
            .Select(token =>
            {
                var kind = token.IsKeyword() ? SourceTokenKind.Keyword
                    : token.IsKind(SyntaxKind.IdentifierToken) ? SourceTokenKind.Identifier
                    : token.Value is not null ? SourceTokenKind.Literal
                    : SourceTokenKind.Symbol;
                return new SourceToken(kind, token.ValueText, token.GetLocation().GetLineSpan().StartLinePosition.Line + 1);
            }).ToList();

        var comments = new List<CommentInfo>();
        foreach (var trivia in root.DescendantTrivia(descendIntoTrivia: false))
        {
            var isDocumentation = trivia.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia) || trivia.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia);
            if (!isDocumentation && !trivia.IsKind(SyntaxKind.SingleLineCommentTrivia) && !trivia.IsKind(SyntaxKind.MultiLineCommentTrivia)) continue;
            comments.Add(new CommentInfo(trivia.ToFullString().TrimEnd(), Locations.Of(trivia.GetLocation()), isDocumentation));
        }
        return new SourceFile(tree.FilePath, string.Empty, tree.GetText().ToString()) { Tokens = tokens, Comments = comments, HasSyntaxErrors = tree.GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error) };
    }
}

internal static class Locations
{
    public static SourceLocation Of(Location location)
    {
        var span = location.GetLineSpan();
        return new SourceLocation(span.Path, span.StartLinePosition.Line + 1, span.StartLinePosition.Character + 1, span.EndLinePosition.Line + 1, span.EndLinePosition.Character + 1);
    }

    public static SourceLocation Of(SyntaxNode node) => Of(node.GetLocation());
}
