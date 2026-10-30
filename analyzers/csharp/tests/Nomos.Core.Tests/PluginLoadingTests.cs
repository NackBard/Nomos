using System.Reflection;
using Nomos.Abstractions;
using Nomos.Core;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Nomos.Core.Tests;

public class PluginLoadingTests
{
    private const string PluginSource = """
        using Nomos.Abstractions;
        [Analyzer("EXT001", "External", Title = "From a plugin")]
        public sealed class ExternalAnalyzer : AnalyzerBase
        {
            public override void Analyze(AnalysisContext context) =>
                context.Report(new Metric("plugin-ran", MetricScope.Project, "p", 1));
        }
        """;

    [Fact]
    public async Task PluginFromFolder_IsDiscoveredAndRuns_WithoutCoreChanges()
    {
        var folder = Directory.CreateTempSubdirectory().FullName;
        Compile(Path.Combine(folder, "External.dll"));
        File.WriteAllText(Path.Combine(folder, "broken.dll"), "not an assembly");

        var diagnostics = new List<ToolDiagnostic>();
        var plugins = PluginLoader.LoadPlugins(folder, diagnostics);
        var catalog = ComponentCatalog.Discover([typeof(EngineTests).Assembly, .. plugins]);
        var result = await new AnalysisEngine(catalog.Filter(d => d.Id == "EXT001")).RunAsync(new AnalysisRequest
        {
            ProjectName = "t",
            Sources = new Dictionary<string, IReadOnlyList<SourceInput>> { ["toy"] = [new SourceInput("a.toy", "A")] },
        });

        Assert.Contains(diagnostics, d => d.Message.Contains("broken.dll", StringComparison.Ordinal));
        Assert.Equal("plugin-ran", Assert.Single(result.Metrics).Id);
    }

    [Fact]
    public void MissingPluginFolder_IsNotAnError() => Assert.Empty(PluginLoader.LoadPlugins("/no/such/folder", new List<ToolDiagnostic>()));

    [Fact]
    public void DuplicateAnalyzerIds_AreDiagnosed()
    {
        var catalog = ComponentCatalog.Discover([typeof(EngineTests).Assembly]);
        catalog.Add(typeof(EngineTests).Assembly);
        Assert.Contains(catalog.Diagnostics, d => d.Message.Contains("Duplicate analyzer id", StringComparison.Ordinal));
    }

    private static void Compile(string path)
    {
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator).Select(p => MetadataReference.CreateFromFile(p));
        var compilation = CSharpCompilation.Create("External", [CSharpSyntaxTree.ParseText(PluginSource)], references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var emit = compilation.Emit(path);
        Assert.True(emit.Success, string.Join("\n", emit.Diagnostics));
    }
}
