using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Nomos.Analyzer.CSharp;
using Xunit;

namespace Nomos.Analyzers.Tests;

/// <summary>
/// Every text of a finding is a template of spec/rules (spec/l10n.md): the interpolated strings passed to Report are
/// read from the analyzer sources, so a branch that no fixture reaches is checked too.
/// </summary>
public class MessageTemplateTests
{
    private static readonly IReadOnlyDictionary<string, Facts.RuleText> Spec = SpecRules.Load();

    [Fact]
    public void EveryReportedText_IsATemplateOfItsRule()
    {
        var templates = SourceTemplates();
        Assert.NotEmpty(templates);
        var dump = Environment.GetEnvironmentVariable("NOMOS_DUMP_TEMPLATES");
        if (!string.IsNullOrEmpty(dump))
            File.WriteAllText(dump, JsonSerializer.Serialize(templates.Select(t => new { t.Rule, t.Template, t.Where, t.Problem }), new JsonSerializerOptions { WriteIndented = true }));
        var missing = templates.Where(t => t.Problem is not null || Spec.GetValueOrDefault(t.Rule)?.Messages?.Values.Contains(t.Template) != true)
            .Select(t => $"{t.Where} {t.Rule}: {t.Problem ?? "not in spec"}: {t.Template}").ToList();
        Assert.Empty(missing);
    }

    private sealed record Found(string Rule, string Template, string Where, string? Problem);

    private static List<Found> SourceTemplates()
    {
        var root = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src");
        var result = new List<Found>();
        foreach (var file in Directory.GetDirectories(root, "Nomos.Analyzers.*").SelectMany(d => Directory.GetFiles(d, "*.cs", SearchOption.AllDirectories))
                     .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)).Order(StringComparer.Ordinal))
        {
            var tree = CSharpSyntaxTree.ParseText(File.ReadAllText(file));
            foreach (var call in tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>().Where(IsReport))
            {
                var rule = RuleOf(call);
                foreach (var text in call.ArgumentList.Arguments.SelectMany(a => a.Expression.DescendantNodesAndSelf(n => n is not InvocationExpressionSyntax || n == a.Expression).OfType<InterpolatedStringExpressionSyntax>()))
                {
                    if (text.Ancestors().OfType<InterpolationSyntax>().Any()) continue;
                    var line = text.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
                    result.Add(new Found(rule ?? "?", Template(text), $"{Path.GetFileName(file)}:{line}", rule is null ? "no [Analyzer] on the enclosing class" : Problem(text)));
                }
            }
        }
        return result;
    }

    private static bool IsReport(InvocationExpressionSyntax call) => call.Expression switch
    {
        MemberAccessExpressionSyntax member => member.Name.Identifier.Text == "Report",
        IdentifierNameSyntax name => name.Identifier.Text == "Report",
        _ => false,
    };

    private static string? RuleOf(SyntaxNode node)
    {
        var attribute = node.Ancestors().OfType<ClassDeclarationSyntax>().SelectMany(c => c.AttributeLists.SelectMany(l => l.Attributes))
            .FirstOrDefault(a => a.Name.ToString() is "Analyzer" or "AnalyzerAttribute");
        return attribute?.ArgumentList?.Arguments.FirstOrDefault()?.Expression is LiteralExpressionSyntax literal ? literal.Token.ValueText : null;
    }

    /// <summary>The template as <see cref="Abstractions.TemplateText.From"/> builds it: holes numbered in order.</summary>
    private static string Template(InterpolatedStringExpressionSyntax text)
    {
        var builder = new StringBuilder();
        var index = 0;
        foreach (var content in text.Contents)
        {
            if (content is InterpolatedStringTextSyntax part) builder.Append(part.TextToken.Text);
            else builder.Append('{').Append(index++).Append('}');
        }
        return builder.ToString();
    }

    /// <summary>English inside a hole would stay English in every language: a literal with letters or a nested template.</summary>
    private static string? Problem(InterpolatedStringExpressionSyntax text)
    {
        foreach (var hole in text.Contents.OfType<InterpolationSyntax>())
        {
            if (hole.Expression.DescendantNodesAndSelf().OfType<InterpolatedStringExpressionSyntax>().Any()) return "a template inside a hole";
            var words = hole.Expression.DescendantNodesAndSelf().OfType<LiteralExpressionSyntax>()
                .Where(l => l.IsKind(SyntaxKind.StringLiteralExpression) && l.Token.ValueText.Any(char.IsLetter)).Select(l => l.Token.ValueText).ToList();
            if (words.Count > 0) return $"words in a hole ({string.Join(", ", words)})";
        }
        return null;
    }
}
