using Nomos.Abstractions;
using Nomos.Abstractions.Ir;

namespace Nomos.Graph;

/// <summary>A directed graph over string node keys. Enumeration order is deterministic.</summary>
public sealed class DirectedGraph
{
    private readonly SortedDictionary<string, SortedSet<string>> _successors = new(StringComparer.Ordinal);
    private readonly SortedDictionary<string, SortedSet<string>> _predecessors = new(StringComparer.Ordinal);

    /// <summary>Gets the nodes.</summary>
    public IEnumerable<string> Nodes => _successors.Keys;

    /// <summary>Adds a node.</summary>
    /// <param name="node">The node.</param>
    public void AddNode(string node)
    {
        if (_successors.ContainsKey(node)) return;
        _successors[node] = new(StringComparer.Ordinal);
        _predecessors[node] = new(StringComparer.Ordinal);
    }

    /// <summary>Adds an edge, creating its nodes.</summary>
    /// <param name="from">Source.</param>
    /// <param name="to">Target.</param>
    public void AddEdge(string from, string to)
    {
        AddNode(from);
        AddNode(to);
        _successors[from].Add(to);
        _predecessors[to].Add(from);
    }

    /// <summary>Gets direct successors.</summary>
    /// <param name="node">The node.</param>
    public IReadOnlyCollection<string> Successors(string node) => _successors.TryGetValue(node, out var set) ? set : [];

    /// <summary>Gets direct predecessors.</summary>
    /// <param name="node">The node.</param>
    public IReadOnlyCollection<string> Predecessors(string node) => _predecessors.TryGetValue(node, out var set) ? set : [];
}

/// <summary>Tarjan's strongly connected components, iterative so deep graphs cannot overflow the stack.</summary>
public static class Tarjan
{
    /// <summary>Finds all strongly connected components, each sorted.</summary>
    /// <param name="graph">The graph.</param>
    public static IReadOnlyList<IReadOnlyList<string>> StronglyConnectedComponents(DirectedGraph graph)
    {
        var index = new Dictionary<string, int>();
        var low = new Dictionary<string, int>();
        var onStack = new HashSet<string>();
        var stack = new Stack<string>();
        var result = new List<IReadOnlyList<string>>();
        var counter = 0;

        foreach (var start in graph.Nodes)
        {
            if (index.ContainsKey(start)) continue;
            var work = new Stack<(string Node, IEnumerator<string> Next)>();
            Enter(start);
            while (work.Count > 0)
            {
                var (node, next) = work.Peek();
                if (next.MoveNext())
                {
                    var successor = next.Current;
                    if (!index.ContainsKey(successor)) Enter(successor);
                    else if (onStack.Contains(successor)) low[node] = Math.Min(low[node], index[successor]);
                    continue;
                }

                work.Pop();
                if (work.Count > 0) low[work.Peek().Node] = Math.Min(low[work.Peek().Node], low[node]);
                if (low[node] != index[node]) continue;

                var component = new List<string>();
                string member;
                do
                {
                    member = stack.Pop();
                    onStack.Remove(member);
                    component.Add(member);
                } while (member != node);
                component.Sort(StringComparer.Ordinal);
                result.Add(component);
            }

            void Enter(string node)
            {
                index[node] = low[node] = counter++;
                stack.Push(node);
                onStack.Add(node);
                work.Push((node, graph.Successors(node).GetEnumerator()));
            }
        }
        return result;
    }

    /// <summary>Finds dependency cycles: components with several nodes, or a node with an edge to itself.</summary>
    /// <param name="graph">The graph.</param>
    public static IReadOnlyList<IReadOnlyList<string>> Cycles(DirectedGraph graph) =>
        [.. StronglyConnectedComponents(graph)
            .Where(c => c.Count > 1 || graph.Successors(c[0]).Contains(c[0]))
            .OrderBy(c => c[0], StringComparer.Ordinal)];
}

/// <summary>Impact of changing a node.</summary>
/// <param name="Node">The changed node.</param>
/// <param name="Direct">Direct dependents.</param>
/// <param name="Transitive">All nodes reached through reversed edges.</param>
/// <param name="MaxDepth">Longest shortest path from the node to a dependent.</param>
/// <param name="ShareOfGraph">Fraction of the other nodes that are affected.</param>
public sealed record BlastRadiusResult(string Node, int Direct, IReadOnlyList<string> Transitive, int MaxDepth, double ShareOfGraph);

/// <summary>Computes what can break when a node changes.</summary>
public static class BlastRadius
{
    /// <summary>Walks reversed dependency edges breadth first.</summary>
    /// <param name="graph">Dependency graph; an edge A to B means A depends on B.</param>
    /// <param name="node">The changed node.</param>
    public static BlastRadiusResult Compute(DirectedGraph graph, string node)
    {
        var distance = new Dictionary<string, int> { [node] = 0 };
        var queue = new Queue<string>([node]);
        while (queue.Count > 0)
        {
            var current = queue.Dequeue();
            foreach (var dependent in graph.Predecessors(current))
            {
                if (distance.TryAdd(dependent, distance[current] + 1)) queue.Enqueue(dependent);
            }
        }
        var affected = distance.Keys.Where(k => k != node).Order(StringComparer.Ordinal).ToList();
        var others = Math.Max(1, graph.Nodes.Count() - 1);
        return new BlastRadiusResult(node, graph.Predecessors(node).Count(p => p != node), affected, distance.Values.Max(), (double)affected.Count / others);
    }

    /// <summary>
    /// Counts the transitive dependents of every node in one pass over the condensation of the graph, so that the cost does
    /// not grow with one walk per node. Memory is one bit per pair of component and node.
    /// </summary>
    /// <param name="graph">Dependency graph; an edge A to B means A depends on B.</param>
    public static IReadOnlyDictionary<string, int> Counts(DirectedGraph graph)
    {
        var components = Tarjan.StronglyConnectedComponents(graph);
        var nodeIndex = graph.Nodes.Select((n, i) => (n, i)).ToDictionary(p => p.n, p => p.i, StringComparer.Ordinal);
        var componentOf = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var c = 0; c < components.Count; c++)
            foreach (var member in components[c]) componentOf[member] = c;

        var words = (nodeIndex.Count + 63) / 64;
        var reached = new ulong[components.Count][];
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        // Tarjan emits a component after everything it depends on, so going backwards visits dependents first.
        for (var c = components.Count - 1; c >= 0; c--)
        {
            var bits = reached[c] = new ulong[words];
            foreach (var member in components[c])
            {
                foreach (var dependent in graph.Predecessors(member))
                {
                    var other = componentOf[dependent];
                    if (other == c) continue;
                    var from = reached[other];
                    for (var w = 0; w < words; w++) bits[w] |= from[w];
                    foreach (var outside in components[other]) bits[nodeIndex[outside] / 64] |= 1UL << (nodeIndex[outside] % 64);
                }
            }
            var total = bits.Sum(System.Numerics.BitOperations.PopCount) + components[c].Count - 1;
            foreach (var member in components[c]) counts[member] = total;
        }
        return counts;
    }
}

/// <summary>Robert C. Martin's package metrics.</summary>
/// <param name="Module">Module name.</param>
/// <param name="TypeCount">Types in the module.</param>
/// <param name="AbstractCount">Interfaces and abstract classes in the module.</param>
/// <param name="AfferentCoupling">Ca: outside types that depend on types of this module.</param>
/// <param name="EfferentCoupling">Ce: distinct outside project types the types of this module depend on.</param>
public sealed record PackageMetrics(string Module, int TypeCount, int AbstractCount, int AfferentCoupling, int EfferentCoupling)
{
    /// <summary>Gets I = Ce / (Ca + Ce); <c>null</c> when the module is isolated (spec/metrics.md).</summary>
    public double? Instability => AfferentCoupling + EfferentCoupling == 0 ? null : (double)EfferentCoupling / (AfferentCoupling + EfferentCoupling);

    /// <summary>Gets A = abstract types / types.</summary>
    public double? Abstractness => TypeCount == 0 ? null : (double)AbstractCount / TypeCount;

    /// <summary>Gets D = |A + I - 1|, the distance from the main sequence.</summary>
    public double? Distance => Abstractness is null || Instability is null ? null : Math.Abs(Abstractness.Value + Instability.Value - 1);
}

/// <summary>Dependency graphs of a model, restricted to types declared in the project.</summary>
public sealed class DependencyGraphs
{
    private const string CacheKey = "Nomos.Graph.DependencyGraphs";

    private readonly Lazy<IReadOnlyDictionary<string, int>> _blastRadii;

    private DependencyGraphs(ProjectModel model)
    {
        _blastRadii = new(() => BlastRadius.Counts(Types));
        var moduleOf = model.AllTypes.GroupBy(t => t.Id).ToDictionary(g => g.Key, g => g.First().ModuleName);
        foreach (var type in model.AllTypes)
        {
            Types.AddNode(type.Id);
            Modules.AddNode(type.ModuleName);
            foreach (var dependency in type.Dependencies.Where(d => !d.IsExternal && moduleOf.ContainsKey(d.TargetTypeId)))
            {
                if (dependency.TargetTypeId == type.Id) continue;
                Types.AddEdge(type.Id, dependency.TargetTypeId);
                var targetModule = moduleOf[dependency.TargetTypeId];
                if (targetModule != type.ModuleName) Modules.AddEdge(type.ModuleName, targetModule);
            }
        }

        foreach (var module in model.Modules)
        {
            Modules.AddNode(module.Name);
            var inside = module.AllTypes.Select(t => t.Id).ToHashSet();
            var afferent = inside.SelectMany(Types.Predecessors).Where(p => !inside.Contains(p)).Distinct().Count();
            var efferent = inside.SelectMany(Types.Successors).Where(s => !inside.Contains(s)).Distinct().Count();
            Packages[module.Name] = new PackageMetrics(module.Name, inside.Count, module.AllTypes.Count(t => t.IsAbstract), afferent, efferent);
        }
    }

    /// <summary>Gets the type-level graph; an edge A to B means A depends on B.</summary>
    public DirectedGraph Types { get; } = new();

    /// <summary>Gets the module-level graph.</summary>
    public DirectedGraph Modules { get; } = new();

    /// <summary>Gets the blast radius of every type by id, computed once.</summary>
    public IReadOnlyDictionary<string, int> BlastRadii => _blastRadii.Value;

    /// <summary>Gets package metrics by module name.</summary>
    public Dictionary<string, PackageMetrics> Packages { get; } = new(StringComparer.Ordinal);

    /// <summary>Builds graphs for a model.</summary>
    /// <param name="model">The model.</param>
    public static DependencyGraphs Build(ProjectModel model) => new(model);

    /// <summary>Gets the graphs of the current analysis, building them once.</summary>
    /// <param name="context">The analysis context.</param>
    public static DependencyGraphs From(AnalysisContext context) => context.Shared.GetOrAdd(CacheKey, () => Build(context.Model));
}
