using System.Text.Json;
using Nomos.Abstractions;
using Nomos.Core;

namespace Nomos.Analyzer.CSharp;

/// <summary>Reads the workspace file (contracts/nomos.schema.json) named by <c>--config</c> into engine settings.</summary>
internal static class WorkspaceFile
{
    private const string SupportedMajor = "1.";
    private const string Language = Abstractions.Languages.CSharp;

    public static NomosConfig Load(string path)
    {
        if (!File.Exists(path)) throw new ConfigurationException($"Config file not found: {path}");
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(path), new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
            var root = document.RootElement;
            var version = root.TryGetProperty("schemaVersion", out var value) ? value.GetString() : null;
            if (version is null || !version.StartsWith(SupportedMajor, StringComparison.Ordinal))
                throw new ConfigurationException($"{path}: expected schemaVersion {SupportedMajor}x, found '{version}'.");
            return ToConfig(root);
        }
        catch (Exception exception) when (exception is JsonException or InvalidOperationException or KeyNotFoundException or ArgumentException)
        {
            throw new ConfigurationException($"{path}: {exception.Message}", exception);
        }
    }

    private static NomosConfig ToConfig(JsonElement root)
    {
        var entry = root.GetProperty("analyzers").EnumerateArray().FirstOrDefault(a => a.GetProperty("language").GetString() == Language);
        var config = new NomosConfig
        {
            Include = Strings(entry, "include"),
            Exclude = Strings(entry, "exclude"),
            Layers = root.TryGetProperty("layers", out var layers) ? layers.Deserialize<List<LayerRule>>(NomosConfig.SerializerOptions) ?? [] : [],
            Scoring = root.TryGetProperty("scoring", out var scoring) ? scoring.Deserialize<ScoringConfig>(NomosConfig.SerializerOptions) ?? new ScoringConfig() : new ScoringConfig(),
        };
        if (root.TryGetProperty("paradigms", out var paradigms) && paradigms.TryGetProperty(Language, out var own))
            config.Languages[Language] = new LanguageConfig { Paradigms = [.. own.EnumerateArray().Select(p => p.GetString()!)] };
        if (root.TryGetProperty("rules", out var rules))
        {
            foreach (var rule in rules.EnumerateObject()) config.Analyzers[rule.Name] = ToAnalyzer(rule.Value);
        }
        return config;
    }

    private static AnalyzerConfig ToAnalyzer(JsonElement rule)
    {
        var thresholds = new Dictionary<string, JsonElement>(StringComparer.OrdinalIgnoreCase);
        if (rule.TryGetProperty("threshold", out var threshold))
        {
            foreach (var option in threshold.EnumerateObject()) thresholds[option.Name] = option.Value.Clone();
        }
        return new AnalyzerConfig
        {
            Enabled = rule.TryGetProperty("enabled", out var enabled) ? enabled.GetBoolean() : null,
            Severity = rule.TryGetProperty("severity", out var severity) ? Enum.Parse<Severity>(severity.GetString()!, ignoreCase: true) : null,
            Thresholds = thresholds,
        };
    }

    private static List<string> Strings(JsonElement entry, string name) =>
        entry.ValueKind == JsonValueKind.Object && entry.TryGetProperty(name, out var list) ? [.. list.EnumerateArray().Select(s => s.GetString()!)] : [];
}
