using System.Text.RegularExpressions;
using Nomos.Abstractions;
using Nomos.Abstractions.Ir;

namespace Nomos.Core;

/// <summary>
/// Applies suppressions: config entries, comment directives
/// (nomos-disable, nomos-disable-line, nomos-disable-next-line)
/// and the attributes [NomosSuppress("ID")] and [SuppressMessage("Nomos", "ID")].
/// </summary>
internal sealed partial class SuppressionFilter
{
    private readonly ProjectModel _model;
    private readonly IReadOnlyList<SuppressionConfig> _configured;
    private readonly Dictionary<string, FileDirectives> _directives = [];

    public SuppressionFilter(ProjectModel model, IReadOnlyList<SuppressionConfig> configured)
    {
        _model = model;
        _configured = configured;
        foreach (var file in model.Files) _directives[file.Path] = ParseDirectives(file);
    }

    public bool IsSuppressed(Finding finding)
    {
        var location = finding.Evidence.Location;
        if (_configured.Any(s => Matches(s.Id, finding.AnalyzerId) && Glob.IsMatch(s.Path, location.FilePath))) return true;
        if (_directives.TryGetValue(location.FilePath, out var directives) && directives.Covers(finding.AnalyzerId, location.StartLine)) return true;
        return HasAttribute(finding);
    }

    private static bool Matches(string pattern, string id) => pattern == "*" || string.Equals(pattern, id, StringComparison.OrdinalIgnoreCase);

    private bool HasAttribute(Finding finding)
    {
        if (finding.Symbol is null) return false;
        var callable = _model.FindCallable(finding.Symbol);
        if (callable is not null && Suppresses(callable.Attributes, finding.AnalyzerId)) return true;

        // Walks enclosing types, as a type-level attribute covers its members and nested types.
        var typeId = callable?.DeclaringTypeId ?? finding.Symbol;
        while (typeId is not null)
        {
            if (_model.FindType(typeId) is { } type && Suppresses(type.Attributes, finding.AnalyzerId)) return true;
            var dot = typeId.LastIndexOf('.');
            typeId = dot > 0 ? typeId[..dot] : null;
        }
        return false;
    }

    private static bool Suppresses(IReadOnlyList<AttributeInfo> attributes, string id) => attributes.Any(attribute => attribute switch
    {
        { Name: "NomosSuppress" } => attribute.Arguments.Any(a => Matches(a, id)),
        { Name: "SuppressMessage", Arguments: [var category, var check, ..] } =>
            category.StartsWith("Nomos", StringComparison.OrdinalIgnoreCase) && Matches(check.Split(':')[0].Trim(), id),
        _ => false,
    });

    private static FileDirectives ParseDirectives(SourceFile file)
    {
        var directives = new FileDirectives();
        foreach (var comment in file.Comments)
        {
            var match = DirectiveRegex().Match(comment.Text);
            if (!match.Success) continue;
            var ids = match.Groups["ids"].Value.Split([' ', ','], StringSplitOptions.RemoveEmptyEntries);
            if (ids.Length == 0) ids = ["*"];
            switch (match.Groups["scope"].Value)
            {
                case "-line": directives.AddLine(comment.Location.StartLine, ids); break;
                case "-next-line": directives.AddLine(comment.Location.EndLine + 1, ids); break;
                default: directives.File.AddRange(ids); break;
            }
        }
        return directives;
    }

    [GeneratedRegex(@"nomos-disable(?<scope>-next-line|-line)?(?<ids>[ \t,\w]*)")]
    private static partial Regex DirectiveRegex();

    private sealed class FileDirectives
    {
        private readonly Dictionary<int, List<string>> _lines = [];

        public List<string> File { get; } = [];

        public void AddLine(int line, IEnumerable<string> ids)
        {
            if (!_lines.TryGetValue(line, out var list)) _lines[line] = list = [];
            list.AddRange(ids);
        }

        public bool Covers(string id, int line) =>
            File.Any(i => Matches(i, id)) || (_lines.TryGetValue(line, out var ids) && ids.Any(i => Matches(i, id)));
    }
}
