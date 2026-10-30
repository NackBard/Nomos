using Nomos.Abstractions;
using Nomos.Abstractions.Ir;
using Nomos.Languages.CSharp;
using Xunit;

namespace Nomos.Languages.Tests;

public class CSharpAdapterTests
{
    private static async Task<ProjectModel> Load(params string[] sources)
    {
        var inputs = sources.Select((s, i) => new SourceInput($"f{i}.cs", s)).ToList();
        var result = await new CSharpLanguageAdapter().LoadAsync(inputs, CancellationToken.None);
        return new ProjectModel("t", result.Modules, result.Files);
    }

    [Fact]
    public async Task Namespaces_BecomeModules_AndPartialTypesMerge()
    {
        var model = await Load(
            "namespace A.B; public partial class P { public int X; }",
            "namespace A.B; public partial class P { public void M() { } } class Q { class N { } }",
            "class G { }");

        Assert.Equal(["(global)", "A.B"], model.Modules.Select(m => m.Name).Order(StringComparer.Ordinal));
        var partial = model.FindType("A.B.P")!;
        Assert.Single(partial.Fields);
        Assert.Single(partial.Callables);
        Assert.True(partial.Has(Modifiers.Partial));
        Assert.NotNull(model.FindType("A.B.Q.N"));
    }

    [Fact]
    public async Task Inheritance_IsResolvedSemantically()
    {
        var model = await Load("interface I { void M(); } class B { } class D : B, I { public void M() { } }  class E : D { }");
        var derived = model.FindType("D")!;

        Assert.Equal("B", derived.BaseType!.Id);
        Assert.Equal("I", Assert.Single(derived.Interfaces).Id);
        Assert.Equal(1, derived.InheritanceDepth);
        Assert.Equal(2, model.FindType("E")!.InheritanceDepth);
        Assert.Contains("I.M()", derived.Callables[0].Implements);
        Assert.Contains(derived.Dependencies, d => d is { TargetTypeId: "I", Kind: DependencyKind.Implementation, IsExternal: false });
    }

    [Fact]
    public async Task Bodies_MapToIr_WithBoundSymbols()
    {
        var model = await Load("""
            class C {
                private int _n;
                public int Go(List<int> items) {
                    foreach (var i in items) { if (i > 0) { _n += i; } }
                    return items.Count > 0 ? _n : Helper(1);
                }
                private static int Helper(int v) => v;
            }
            """);
        var go = model.FindType("C")!.Callables[0];

        var loop = Assert.Single(go.Body.All<LoopStatement>());
        Assert.Equal(LoopKind.ForEach, loop.Kind);
        Assert.Equal("i", loop.Variable);
        Assert.Single(go.Body.All<IfStatement>());
        var write = DataFlow.Analyze(go.Body).MemberWrites.Single();
        Assert.Equal("C._n", write.Symbol.Id);
        var call = Assert.Single(go.Body.All<InvocationExpression>());
        Assert.Equal("C.Helper(System.Int32)", call.Target.Id);
        Assert.False(call.Target.IsExternal);
        Assert.Equal("List<int>", loop.Iterable!.Type!.Name);
    }

    [Fact]
    public async Task PrimaryConstructorParameters_ActAsFields()
    {
        var model = await Load("class C(int value) : System.Exception(value.ToString()) { public int Get() => value; } record R(int X);");
        var type = model.FindType("C")!;

        Assert.Contains(type.Fields, f => f.Name == "value");
        Assert.Contains(TypeMetrics.OwnMembersUsed(type.Callables.Single(c => c.Name == "Get"), type), id => id == "C.value");
        Assert.Contains(model.FindType("R")!.Properties, p => p is { Name: "X", IsInitOnly: true });
    }

    [Fact]
    public async Task ConditionalAccess_KeepsItsReceiver()
    {
        var model = await Load("class C { string? Go(string? s) => s?.Trim().ToUpper(); }");
        var calls = model.FindType("C")!.Callables[0].Body.All<InvocationExpression>().ToList();
        Assert.Equal(["ToUpper", "Trim"], calls.Select(c => c.Target.Name));
        Assert.IsType<NameExpression>(calls[1].Receiver);
    }

    [Fact]
    public async Task TopLevelStatements_BecomeAFreeFunction()
    {
        var model = await Load("var x = 1; System.Console.WriteLine(x);");
        var function = Assert.Single(model.Modules.Single().Functions);
        Assert.Equal(CallableKind.Function, function.Kind);
        Assert.Equal(2, function.Body!.Statements.Count);
    }

    [Fact]
    public async Task Lexing_SeparatesCommentsAndTokens()
    {
        var model = await Load("/// <summary>Doc</summary>\nclass C { } // note\n");
        var file = model.Files.Single();
        Assert.Equal(2, file.Comments.Count);
        Assert.True(file.Comments[0].IsDocumentation);
        Assert.Equal("csharp", file.Language);
        Assert.Contains(file.Tokens, t => t is { Kind: SourceTokenKind.Identifier, Text: "C", Line: 2 });
    }

    [Fact]
    public async Task UnresolvedTypes_FallBackToNames_WithDiagnostics()
    {
        var result = await new CSharpLanguageAdapter().LoadAsync([new SourceInput("a.cs", "class C { Missing _m; }")], CancellationToken.None);
        var field = result.Modules.Single().Types.Single().Fields.Single();
        Assert.Equal("Missing", field.Type!.Name);
        Assert.False(field.Type.IsResolved);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("unresolved", StringComparison.Ordinal));
    }

    [Fact]
    public void ProjectFiles_ExpandToProjectDirectories()
    {
        var root = Directory.CreateTempSubdirectory().FullName;
        Directory.CreateDirectory(Path.Combine(root, "a"));
        Directory.CreateDirectory(Path.Combine(root, "b"));
        var sln = Path.Combine(root, "x.sln");
        File.WriteAllText(sln, """Project("{FAE}") = "a", "a\a.csproj", "{1}" """ + "\n" + """Project("{FAE}") = "b", "b\b.csproj", "{2}" """);
        var slnx = Path.Combine(root, "y.slnx");
        File.WriteAllText(slnx, """<Solution><Project Path="a/a.csproj" /></Solution>""");
        var adapter = new CSharpLanguageAdapter();

        Assert.True(adapter.CanExpand(sln));
        Assert.Equal(2, adapter.ExpandToDirectories(sln).Count);
        Assert.Equal(Path.Combine(root, "a"), Assert.Single(adapter.ExpandToDirectories(slnx)));
    }

    [Theory]
    [InlineData("int M(int a) { return a; }", 1)]
    [InlineData("int M(int a) { if (a > 0 && a < 2) return 1; return a > 3 ? 2 : 3; }", 4)]
    [InlineData("int M(int a) { switch (a) { case 1: return 1; case 2: return 2; default: return 0; } }", 3)]
    [InlineData("int M(int[] a) { foreach (var i in a) { try { } catch { } } return 0; }", 3)]
    public async Task CyclomaticComplexity_CountsDecisions(string method, int expected)
    {
        var model = await Load($"class C {{ {method} }}");
        Assert.Equal(expected, ControlFlow.CyclomaticComplexity(model.FindType("C")!.Callables[0]));
    }
}
