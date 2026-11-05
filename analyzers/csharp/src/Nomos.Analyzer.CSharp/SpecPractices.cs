using Nomos.Core;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace Nomos.Analyzer.CSharp;

/// <summary>The practice catalog embedded from <c>spec/practices.yaml</c> at build time (D-051).</summary>
internal static class SpecPractices
{
    private const string Resource = "spec/practices.yaml";

    /// <summary>Rule ids by practice id, in catalog order.</summary>
    public static IReadOnlyList<(string Id, IReadOnlyList<string> Rules)> Load()
    {
        var deserializer = new DeserializerBuilder().WithNamingConvention(CamelCaseNamingConvention.Instance).IgnoreUnmatchedProperties().Build();
        using var reader = new StreamReader(typeof(SpecPractices).Assembly.GetManifestResourceStream(Resource)!);
        return [.. deserializer.Deserialize<CatalogFile>(reader).Practices.Select(p => (p.Id, (IReadOnlyList<string>)p.Rules))];
    }

    /// <summary>
    /// For each rule outside the selected practices, the message recorded in skippedRules. The same text as the Go analyzer.
    /// </summary>
    /// <exception cref="ConfigurationException">A selected id is not in the catalog.</exception>
    public static IReadOnlyDictionary<string, string> Outside(IReadOnlyCollection<string> selected, string source)
    {
        var catalog = Load();
        var unknown = selected.FirstOrDefault(id => catalog.All(p => p.Id != id));
        if (unknown is not null) throw new ConfigurationException($"{source}: unknown practice '{unknown}'");

        var owners = new SortedDictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var (id, rules) in catalog)
        {
            foreach (var rule in rules)
            {
                if (!owners.TryGetValue(rule, out var list)) owners[rule] = list = [];
                list.Add(id);
            }
        }
        return owners.Where(o => !o.Value.Any(selected.Contains)).ToDictionary(
            o => o.Key,
            o => $"Rule belongs to practice {string.Join(" or ", o.Value.Order(StringComparer.Ordinal))}, which is not selected; 'practices' in nomos.json selects them",
            StringComparer.Ordinal);
    }

    private sealed class CatalogFile
    {
        public List<CatalogPractice> Practices { get; set; } = [];
    }

    private sealed class CatalogPractice
    {
        public string Id { get; set; } = "";

        public List<string> Rules { get; set; } = [];
    }
}
