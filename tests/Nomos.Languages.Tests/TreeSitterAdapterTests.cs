using Nomos.Abstractions;
using Nomos.Abstractions.Ir;
using Nomos.Languages.TreeSitter;
using Xunit;

namespace Nomos.Languages.Tests;

public class TreeSitterAdapterTests
{
    private sealed record Node(string Type, string Text, IReadOnlyList<ISyntaxNode> Children) : ISyntaxNode
    {
        public int StartLine => 1;

        public int EndLine => 1;

        public ISyntaxNode? Field(string fieldName) => null;
    }

    private sealed class FakeParser : ITreeSitterParser
    {
        public ISyntaxNode Parse(string text) => new Node("module", text, [new Node("comment", "# hi", [])]);
    }

    private sealed class ToyAdapter() : TreeSitterAdapterBase(new FakeParser())
    {
        public override string Language => "toy";

        public override IReadOnlyList<string> FileExtensions => [".toy"];

        public override IReadOnlyList<string> SupportedParadigms => [Paradigms.Structural];

        protected override IEnumerable<ModuleDecl> MapFile(string path, ISyntaxNode root) => [new ModuleDecl(path, Language)];
    }

    [Fact]
    public async Task BaseAdapter_ParsesFiles_CollectsComments_AndMapsModules()
    {
        var adapter = new ToyAdapter();
        var result = await adapter.LoadAsync([new SourceInput("a.toy", "x")], CancellationToken.None);

        Assert.Equal("a.toy", Assert.Single(result.Modules).Name);
        Assert.Equal("# hi", Assert.Single(Assert.Single(result.Files).Comments).Text);
        Assert.Equal(adapter.SupportedParadigms, adapter.DefaultParadigms);
    }
}
