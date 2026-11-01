using System.Text.RegularExpressions;
using Nomos.Graph;

namespace Nomos.Analyzers.Design;

/// <summary>Reports package metrics and flags modules far from the main sequence.</summary>
[Analyzer("DSN001", Categories.Design, Title = "Main sequence distance", Severity = Severity.Minor,
    Description = "Computes Ca, Ce, instability I, abstractness A and distance D = |A + I - 1| per module. D near 1 means rigid or useless.")]
public sealed class MainSequenceAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var maxDistance = context.Options.Number("maxDistance", 0.7);
        var minCoupling = context.Options.Int("minCoupling", 3);
        var graphs = DependencyGraphs.From(context);
        foreach (var module in context.Modules)
        {
            if (!graphs.Packages.TryGetValue(module.Name, out var package)) continue;
            Metric("ca", package.AfferentCoupling);
            Metric("ce", package.EfferentCoupling);
            Metric("instability", package.Instability);
            Metric("abstractness", package.Abstractness);
            Metric("distance", package.Distance);
            void Metric(string id, double? value)
            {
                if (value is { } known) context.Report(new Metric(id, MetricScope.Module, module.Name, Math.Round(known, 3), module.Name));
            }

            if (package.Distance is not { } distance || package.Instability is not { } instability || package.Abstractness is not { } abstractness
                || distance <= maxDistance || package.AfferentCoupling + package.EfferentCoupling < minCoupling) continue;
            var zone = instability < 0.5 ? "the zone of pain: concrete and heavily depended upon" : "the zone of uselessness: abstract and unused";
            context.Report(Confidence.Medium, module.AllTypes.First().Location,
                $"Module {module.Name} is far from the main sequence (D = {distance:0.00})",
                $"A = {abstractness:0.00}, I = {instability:0.00}, so it sits near {zone}.", module.Name,
                measured: new Measurement("distance", Math.Round(distance, 4), maxDistance));
        }
    }
}

/// <summary>Finds dependency cycles.</summary>
[Analyzer("DSN002", Categories.Design, Title = "Dependency cycles", Severity = Severity.Major,
    Description = "Runs Tarjan's algorithm on the module graph and the type graph.")]
public sealed class DependencyCycleAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var graphs = DependencyGraphs.From(context);
        var own = context.Modules.Select(m => m.Name).ToHashSet();
        foreach (var cycle in Tarjan.Cycles(graphs.Modules).Where(c => c.Any(own.Contains)))
        {
            var location = context.Modules.First(m => cycle.Contains(m.Name)).AllTypes.First().Location;
            context.Report(Confidence.High, location, $"Module cycle: {string.Join(" <-> ", cycle)}",
                "These modules depend on each other, directly or transitively, so none can be built, tested or released alone.", cycle[0]);
        }

        foreach (var cycle in Tarjan.Cycles(graphs.Types))
        {
            if (context.Model.FindType(cycle[0]) is not { } first) continue;
            // Nested types naturally lean on their outer type.
            if (cycle.All(id => id.StartsWith(cycle[0], StringComparison.Ordinal))) continue;
            context.Report(first, Confidence.High, $"Type cycle of {cycle.Count}: {string.Join(" <-> ", cycle.Select(Simple))}",
                "These types reference each other, so a change to one can ripple through all of them.", Severity.Minor);
        }
    }

    private static string Simple(string id) => id[(id.LastIndexOf('.') + 1)..];
}

/// <summary>Checks the configured layer rules.</summary>
[Analyzer("DSN003", Categories.Design, Title = "Layer violations", Severity = Severity.Major,
    Description = "Maps modules to the layers from configuration and flags dependencies on layers that are not allowed.")]
public sealed class LayerViolationAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        if (context.Layers.Count == 0) return;
        foreach (var type in context.Types)
        {
            if (LayerOf(context, type.ModuleName) is not { } source) continue;
            foreach (var dependency in type.Dependencies.Where(d => !d.IsExternal))
            {
                if (context.Model.FindType(dependency.TargetTypeId) is not { } target || target.ModuleName == type.ModuleName) continue;
                if (LayerOf(context, target.ModuleName) is not { } destination || destination.Name == source.Name) continue;
                if (!source.MayDependOn.Contains(destination.Name))
                    context.Report(Confidence.High, dependency.Location, $"{source.Name} must not depend on {destination.Name}",
                        $"{type.Name} ({type.ModuleName}) uses {target.Name} ({target.ModuleName}); allowed: {(source.MayDependOn.Count == 0 ? "none" : string.Join(", ", source.MayDependOn))}.", type.ModuleName, type.Id);
            }
        }
    }

    private static LayerRule? LayerOf(AnalysisContext context, string module) =>
        context.Layers.FirstOrDefault(l => l.Patterns.Any(p => WildcardMatches(p, module)));

    private static bool WildcardMatches(string pattern, string value) =>
        Regex.IsMatch(value, "^" + string.Join(".*", pattern.Split('*').Select(Regex.Escape)) + "$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
}

/// <summary>Detects god classes.</summary>
[Analyzer("DSN004", Categories.Design, Title = "God class", Severity = Severity.Major, Paradigms = [Paradigms.ObjectOriented],
    Description = "Lanza and Marinescu's detection strategy: high WMC, much foreign data used (ATFD), low cohesion (TCC).")]
public sealed class GodClassAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var minWmc = context.Options.Int("minWmc", 47);
        var minAtfd = context.Options.Int("minAtfd", 5);
        var maxTcc = context.Options.Number("maxTcc", 1.0 / 3);
        foreach (var type in context.Types.Where(t => t.Kind == TypeKind.Class))
        {
            var wmc = TypeMetrics.Wmc(type);
            var atfd = TypeMetrics.Atfd(type, context.Model);
            var tcc = TypeMetrics.TccOrNull(type);
            context.Report(new Metric("wmc", MetricScope.Type, type.Id, wmc, type.ModuleName));
            if (wmc >= minWmc && atfd >= minAtfd && tcc is { } cohesion && cohesion < maxTcc)
                context.Report(type, Confidence.Medium, $"{type.Name} looks like a god class",
                    $"WMC = {wmc} (>= {minWmc}), ATFD = {atfd} (>= {minAtfd}), TCC = {cohesion:0.00} (< {maxTcc:0.00}): it does much, uses others' data, and its methods share little.",
                    measured: new Measurement("wmc", wmc, minWmc));
        }
    }
}

/// <summary>Detects feature envy.</summary>
[Analyzer("DSN005", Categories.Design, Title = "Feature envy", Severity = Severity.Minor, Paradigms = [Paradigms.ObjectOriented],
    Description = "A method that uses more data of one other type than of its own probably belongs there.")]
public sealed class FeatureEnvyAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var minForeign = context.Options.Int("minForeignMembers", 3);
        foreach (var type in context.Types)
        {
            // Static methods have no own data to compare against.
            foreach (var callable in type.Callables.Where(TypeMetrics.HasMemberUse))
            {
                if (TypeMetrics.MostUsedForeignType(callable, context.Model) is not var (owner, members)) continue;
                var own = TypeMetrics.OwnMembersUsed(callable, type).Count;
                if (members.Count >= minForeign && members.Count > own)
                    context.Report(Confidence.Medium, callable.Location, $"{callable.Name} is more interested in {context.Model.FindType(owner)?.Name} than in {type.Name}",
                        $"It uses {members.Count} members of {owner} ({string.Join(", ", members.Order(StringComparer.Ordinal))}) and {own} of its own.", type.ModuleName, callable.Id,
                        measured: new Measurement("foreignMembers", members.Count, minForeign));
            }
        }
    }
}

/// <summary>Measures how far a change can spread.</summary>
[Analyzer("DSN006", Categories.Design, Title = "Blast radius", Severity = Severity.Minor,
    Description = "Walks reversed dependencies from each type to count what a change can reach.")]
public sealed class BlastRadiusAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var maxDependents = context.Options.Int("maxDependents", 20);
        var graphs = DependencyGraphs.From(context);
        foreach (var type in context.Types)
        {
            var count = graphs.BlastRadii[type.Id];
            context.Report(new Metric("blast-radius", MetricScope.Type, type.Id, count, type.ModuleName));
            if (count <= maxDependents) continue;
            var radius = BlastRadius.Compute(graphs.Types, type.Id);
            context.Report(type, Confidence.Medium, $"Changing {type.Name} can reach {count} types ({radius.ShareOfGraph:P0})",
                $"{radius.Direct} direct dependents, up to {radius.MaxDepth} hops away. Stable abstractions at such points limit the spread. Static dependencies overstate real impact when a change keeps the contract.",
                measured: new Measurement("blastRadius", count, maxDependents));
        }
    }
}
