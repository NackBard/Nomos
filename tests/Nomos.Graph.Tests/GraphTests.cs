using Nomos.Abstractions;
using Nomos.Abstractions.Ir;
using Xunit;

namespace Nomos.Graph.Tests;

public class GraphTests
{
    private static DirectedGraph Graph(params (string From, string To)[] edges)
    {
        var graph = new DirectedGraph();
        foreach (var (from, to) in edges) graph.AddEdge(from, to);
        return graph;
    }

    [Fact]
    public void Tarjan_FindsOverlappingCycleAsOneComponent()
    {
        var cycles = Tarjan.Cycles(Graph(("a", "b"), ("b", "c"), ("c", "a"), ("c", "d"), ("d", "e"), ("e", "d")));
        Assert.Equal(2, cycles.Count);
        Assert.Equal(["a", "b", "c"], cycles[0]);
        Assert.Equal(["d", "e"], cycles[1]);
    }

    [Fact]
    public void Tarjan_ReportsSelfLoop_ButNotAcyclicGraph()
    {
        Assert.Single(Tarjan.Cycles(Graph(("a", "a"))));
        Assert.Empty(Tarjan.Cycles(Graph(("a", "b"), ("b", "c"), ("a", "c"))));
    }

    [Fact]
    public void Tarjan_SurvivesDeepChains()
    {
        var graph = new DirectedGraph();
        for (var i = 0; i < 200_000; i++) graph.AddEdge($"n{i}", $"n{i + 1}");
        Assert.Equal(200_001, Tarjan.StronglyConnectedComponents(graph).Count);
    }

    [Fact]
    public void BlastRadius_CountsTransitiveDependents()
    {
        var radius = BlastRadius.Compute(Graph(("a", "core"), ("b", "a"), ("c", "b"), ("x", "y")), "core");
        Assert.Equal(1, radius.Direct);
        Assert.Equal(["a", "b", "c"], radius.Transitive);
        Assert.Equal(3, radius.MaxDepth);
        Assert.Equal(0.6, radius.ShareOfGraph, 3);
    }

    [Fact]
    public void PackageMetrics_FollowMartinFormulas()
    {
        var metrics = new PackageMetrics("m", 4, 1, 3, 1);
        Assert.Equal(0.25, metrics.Instability);
        Assert.Equal(0.25, metrics.Abstractness);
        Assert.Equal(0.5, metrics.Distance);
        Assert.Equal(0, new PackageMetrics("isolated", 0, 0, 0, 0).Instability);
    }

    [Fact]
    public void DependencyGraphs_ComputeCouplingBetweenModules()
    {
        var location = new SourceLocation("f", 1, 1, 1, 1);
        TypeDecl Type(string id, string module, params string[] targets) => new(location)
        {
            Id = id,
            Name = id,
            Kind = TypeKind.Class,
            ModuleName = module,
            Dependencies = [.. targets.Select(t => new Dependency(id, t, DependencyKind.Usage, false, location))],
        };
        var model = new ProjectModel("p",
        [
            new ModuleDecl("core", "x") { Types = [Type("c1", "core"), Type("c2", "core", "c1")] },
            new ModuleDecl("app", "x") { Types = [Type("a1", "app", "c1", "c2", "System.String"), Type("a2", "app", "a1")] },
        ], []);

        var graphs = DependencyGraphs.Build(model);

        Assert.Equal(["core"], graphs.Modules.Successors("app"));
        Assert.Equal(new PackageMetrics("core", 2, 0, 1, 0), graphs.Packages["core"]);
        Assert.Equal(new PackageMetrics("app", 2, 0, 0, 1), graphs.Packages["app"]);
    }
}
