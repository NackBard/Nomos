using Nomos.Abstractions;

namespace Nomos.Core;

/// <summary>The analyzers and language adapters a host runs with.</summary>
public sealed class ComponentCatalog
{
    /// <summary>Initializes a catalog.</summary>
    /// <param name="analyzers">Analyzers; ids must be unique.</param>
    /// <param name="adapters">Language adapters.</param>
    /// <exception cref="ArgumentException">Two analyzers share an id.</exception>
    public ComponentCatalog(IEnumerable<IAnalyzer> analyzers, IEnumerable<ILanguageAdapter> adapters)
    {
        Analyzers = [.. analyzers];
        Adapters = [.. adapters];
        var duplicate = Analyzers.GroupBy(a => a.Descriptor.Id, StringComparer.OrdinalIgnoreCase).FirstOrDefault(g => g.Count() > 1);
        if (duplicate is not null) throw new ArgumentException($"Duplicate analyzer id {duplicate.Key}.", nameof(analyzers));
    }

    /// <summary>Gets the analyzers.</summary>
    public IReadOnlyList<IAnalyzer> Analyzers { get; }

    /// <summary>Gets the language adapters.</summary>
    public IReadOnlyList<ILanguageAdapter> Adapters { get; }

    /// <summary>Gets a copy limited to the analyzers that satisfy a predicate.</summary>
    /// <param name="predicate">The predicate.</param>
    public ComponentCatalog Filter(Func<AnalyzerDescriptor, bool> predicate) => new(Analyzers.Where(a => predicate(a.Descriptor)), Adapters);
}
