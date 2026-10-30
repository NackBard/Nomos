using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Nomos.Abstractions;

namespace Nomos.Core;

/// <summary>The content of nomos.json.</summary>
public sealed class NomosConfig
{
    /// <summary>The configuration file name looked up in the analysis root.</summary>
    public const string FileName = "nomos.json";

    /// <summary>Gets settings per language. When empty, every language with an adapter and matching files is analyzed.</summary>
    public Dictionary<string, LanguageConfig> Languages { get; init; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Gets include globs; when empty, every file is included.</summary>
    public List<string> Include { get; init; } = [];

    /// <summary>Gets exclude globs, added to the built-in excludes.</summary>
    public List<string> Exclude { get; init; } = [];

    /// <summary>Gets the plugin directory, relative to the analysis root.</summary>
    public string PluginsPath { get; init; } = "plugins";

    /// <summary>Gets settings per analyzer id.</summary>
    public Dictionary<string, AnalyzerConfig> Analyzers { get; init; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Gets settings per category.</summary>
    public Dictionary<string, CategoryConfig> Categories { get; init; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Gets path-based suppressions.</summary>
    public List<SuppressionConfig> Suppressions { get; init; } = [];

    /// <summary>Gets the intended architecture layers.</summary>
    public List<LayerRule> Layers { get; init; } = [];

    /// <summary>Gets health score settings.</summary>
    public ScoringConfig Scoring { get; init; } = new();

    /// <summary>Loads a configuration file.</summary>
    /// <param name="path">File path.</param>
    /// <exception cref="ConfigurationException">The file is malformed.</exception>
    public static NomosConfig Load(string path)
    {
        try
        {
            return JsonSerializer.Deserialize<NomosConfig>(File.ReadAllText(path), SerializerOptions) ?? new NomosConfig();
        }
        catch (JsonException exception)
        {
            throw new ConfigurationException($"{path}: {exception.Message}", exception);
        }
    }

    /// <summary>Loads nomos.json from a directory, or defaults when it does not exist.</summary>
    /// <param name="directory">The directory.</param>
    public static NomosConfig LoadOrDefault(string directory)
    {
        var path = Path.Combine(directory, FileName);
        return File.Exists(path) ? Load(path) : new NomosConfig();
    }

    /// <summary>Gets the options used for reading and writing configuration.</summary>
    public static JsonSerializerOptions SerializerOptions { get; } = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
        WriteIndented = true,

        // Fills the defaults instead of replacing them: dictionaries keep their case-insensitive
        // comparer, and a partial scoring section keeps the weights it does not mention.
        PreferredObjectCreationHandling = JsonObjectCreationHandling.Populate,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter() },
    };
}

/// <summary>Raised for an invalid configuration.</summary>
/// <param name="message">Message.</param>
/// <param name="inner">Cause.</param>
public sealed class ConfigurationException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>Settings of a language.</summary>
public sealed class LanguageConfig
{
    /// <summary>Gets paradigms to apply; when empty, the adapter defaults apply.</summary>
    public List<string> Paradigms { get; init; } = [];
}

/// <summary>Settings of an analyzer.</summary>
public sealed class AnalyzerConfig
{
    /// <summary>Gets the enabled flag; null keeps the default.</summary>
    public bool? Enabled { get; init; }

    /// <summary>Gets the severity override.</summary>
    public Severity? Severity { get; init; }

    /// <summary>Gets thresholds and other options.</summary>
    public Dictionary<string, JsonElement> Thresholds { get; init; } = new(StringComparer.OrdinalIgnoreCase);
}

/// <summary>Settings of a category.</summary>
public sealed class CategoryConfig
{
    /// <summary>Gets the enabled flag; null keeps the default.</summary>
    public bool? Enabled { get; init; }
}

/// <summary>Suppresses an analyzer on matching paths.</summary>
public sealed class SuppressionConfig
{
    /// <summary>Gets the analyzer id, or "*" for all.</summary>
    public string Id { get; init; } = "*";

    /// <summary>Gets the path glob; defaults to every file.</summary>
    public string Path { get; init; } = "**";
}

/// <summary>Weights of the health score.</summary>
public sealed class ScoringConfig
{
    /// <summary>Gets relative category weights. Unlisted categories weigh 1.</summary>
    public Dictionary<string, double> CategoryWeights { get; init; } = new(StringComparer.OrdinalIgnoreCase)
    {
        [Nomos.Abstractions.Categories.Principles] = 1,
        [Nomos.Abstractions.Categories.CleanCode] = 1,
        [Nomos.Abstractions.Categories.Paradigm] = 0.75,
        [Nomos.Abstractions.Categories.Algorithms] = 1,
        [Nomos.Abstractions.Categories.Design] = 1.25,
        [Nomos.Abstractions.Categories.Patterns] = 0.5,
        [Nomos.Abstractions.Categories.Maintainability] = 1.25,
        [Nomos.Abstractions.Categories.Security] = 1.5,
    };

    /// <summary>Gets the penalty of a finding per severity.</summary>
    public Dictionary<Severity, double> SeverityPenalties { get; init; } = new()
    {
        [Severity.Info] = 0, [Severity.Minor] = 1, [Severity.Major] = 3, [Severity.Critical] = 8,
    };

    /// <summary>Gets the penalty multiplier per confidence.</summary>
    public Dictionary<Confidence, double> ConfidenceFactors { get; init; } = new()
    {
        [Confidence.Low] = 0.25, [Confidence.Medium] = 0.6, [Confidence.High] = 1,
    };

    /// <summary>Gets the penalty per KLOC at which a category score falls to 37 (100/e).</summary>
    public double DecayPerKloc { get; init; } = 20;

    /// <summary>Gets the smallest size in KLOC used for normalization, so tiny modules do not explode.</summary>
    public double MinKloc { get; init; } = 0.2;
}

internal sealed class AnalyzerOptions(AnalyzerConfig? config) : IAnalyzerOptions
{
    private bool TryGet(string key, out JsonElement value)
    {
        value = default;
        return config is not null && config.Thresholds.TryGetValue(key, out value);
    }

    public int Int(string key, int fallback) => TryGet(key, out var value) && value.TryGetInt32(out var number) ? number : fallback;

    public double Number(string key, double fallback) => TryGet(key, out var value) && value.TryGetDouble(out var number) ? number : fallback;

    public string Text(string key, string fallback) => TryGet(key, out var value)
        ? value.ValueKind == JsonValueKind.String ? value.GetString()! : value.GetRawText()
        : fallback;

    public IReadOnlyList<string> List(string key, IReadOnlyList<string> fallback) =>
        TryGet(key, out var value) && value.ValueKind == JsonValueKind.Array
            ? [.. value.EnumerateArray().Select(e => e.GetString() ?? string.Empty)]
            : fallback;
}

/// <summary>Glob matching on forward-slash paths: "*" stays in a segment, "**" crosses segments.</summary>
public static class Glob
{
    /// <summary>Tests a path or dotted name against a pattern.</summary>
    /// <param name="pattern">The pattern.</param>
    /// <param name="value">The value.</param>
    public static bool IsMatch(string pattern, string value) =>
        Regex.IsMatch(value, ToRegex(pattern), RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static string ToRegex(string pattern)
    {
        var regex = new System.Text.StringBuilder("^");
        for (var i = 0; i < pattern.Length; i++)
        {
            var c = pattern[i];
            if (c == '*' && i + 1 < pattern.Length && pattern[i + 1] == '*')
            {
                i++;
                if (i + 1 < pattern.Length && pattern[i + 1] == '/')
                {
                    i++;
                    regex.Append("(.*/)?");
                }
                else regex.Append(".*");
            }
            else if (c == '*') regex.Append("[^/]*");
            else if (c == '?') regex.Append("[^/]");
            else regex.Append(Regex.Escape(c.ToString(CultureInfo.InvariantCulture)));
        }
        return regex.Append('$').ToString();
    }
}
