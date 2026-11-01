using System.Reflection;
using Nomos.Facts;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace Nomos.Analyzer.CSharp;

/// <summary>Reads the rule texts embedded from <c>spec/rules/*.yaml</c> at build time (the single source of truth for rules).</summary>
internal static class SpecRules
{
    private const string Prefix = "spec/rules/";

    public static IReadOnlyDictionary<string, RuleText> Load()
    {
        var deserializer = new DeserializerBuilder().WithNamingConvention(CamelCaseNamingConvention.Instance).IgnoreUnmatchedProperties().Build();
        var assembly = typeof(SpecRules).Assembly;
        var texts = new SortedDictionary<string, RuleText>(StringComparer.Ordinal);
        foreach (var name in assembly.GetManifestResourceNames().Where(n => n.StartsWith(Prefix, StringComparison.Ordinal)).Order(StringComparer.Ordinal))
        {
            using var reader = new StreamReader(assembly.GetManifestResourceStream(name)!);
            var file = deserializer.Deserialize<SpecFile>(reader);
            foreach (var rule in file.Rules) texts[rule.Id] = new RuleText(rule.Title, rule.Description, rule.Rationale, rule.Requires);
        }
        return texts;
    }

    private sealed class SpecFile
    {
        public List<SpecRule> Rules { get; set; } = [];
    }

    private sealed class SpecRule
    {
        public string Id { get; set; } = "";

        public string Title { get; set; } = "";

        public string Description { get; set; } = "";

        public string Rationale { get; set; } = "";

        public List<string> Requires { get; set; } = [];
    }
}
