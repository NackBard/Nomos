using System.Globalization;
using System.Xml.Linq;

namespace Nomos.Abstractions.Ir;

/// <summary>Line coverage read from a Cobertura XML or LCOV report (spec/metrics.md), shared by facts and analyzers.</summary>
public sealed class CoverageReport
{
    private readonly Dictionary<string, Dictionary<int, int>> _files;

    private CoverageReport(Dictionary<string, Dictionary<int, int>> files) => _files = files;

    /// <summary>Reads a report; a file with the extension <c>.xml</c> is Cobertura, any other is LCOV.</summary>
    /// <param name="path">Path of the report.</param>
    public static CoverageReport Load(string path) =>
        new(Path.GetExtension(path).Equals(".xml", StringComparison.OrdinalIgnoreCase) ? ReadCobertura(path) : ReadLcov(path));

    /// <summary>Gets hits by line of a source file; <c>null</c> when the report does not mention it.</summary>
    /// <param name="file">Path relative to the root, forward slashes.</param>
    public IReadOnlyDictionary<int, int>? Lines(string file) =>
        _files.OrderBy(f => f.Key, StringComparer.Ordinal).FirstOrDefault(f => Matches(f.Key.Replace('\\', '/'), file)).Value;

    /// <summary>Gets the percentage of covered lines; <c>null</c> when the report does not mention the file.</summary>
    /// <param name="file">Path relative to the root, forward slashes.</param>
    public double? Percent(string file)
    {
        if (Lines(file) is not { } lines) return null;
        return lines.Count == 0 ? 100 : Math.Round(100.0 * lines.Count(l => l.Value > 0) / lines.Count, 4);
    }

    private static bool Matches(string reported, string file) =>
        reported.Equals(file, StringComparison.OrdinalIgnoreCase) || reported.EndsWith("/" + file, StringComparison.OrdinalIgnoreCase);

    private static Dictionary<string, Dictionary<int, int>> ReadCobertura(string path)
    {
        var result = new Dictionary<string, Dictionary<int, int>>();
        foreach (var @class in XDocument.Load(path).Descendants("class"))
        {
            var file = @class.Attribute("filename")?.Value ?? string.Empty;
            if (!result.TryGetValue(file, out var lines)) result[file] = lines = [];
            foreach (var line in @class.Descendants("line"))
            {
                var number = int.Parse(line.Attribute("number")?.Value ?? "0", CultureInfo.InvariantCulture);
                var hits = int.Parse(line.Attribute("hits")?.Value ?? "0", CultureInfo.InvariantCulture);
                lines[number] = Math.Max(lines.GetValueOrDefault(number), hits);
            }
        }
        return result;
    }

    private static Dictionary<string, Dictionary<int, int>> ReadLcov(string path)
    {
        var result = new Dictionary<string, Dictionary<int, int>>();
        Dictionary<int, int>? current = null;
        foreach (var line in File.ReadLines(path))
        {
            if (line.StartsWith("SF:", StringComparison.Ordinal))
            {
                current = [];
                result[line[3..]] = current;
            }
            else if (line.StartsWith("DA:", StringComparison.Ordinal) && current is not null)
            {
                var parts = line[3..].Split(',');
                current[int.Parse(parts[0], CultureInfo.InvariantCulture)] = int.Parse(parts[1], CultureInfo.InvariantCulture);
            }
        }
        return result;
    }
}
