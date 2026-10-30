using Nomos.Abstractions;
using Nomos.Abstractions.Ir;

namespace Nomos.Languages.TreeSitter;

/// <summary>A concrete syntax tree node, in the shape tree-sitter exposes. Hides the native binding from adapters.</summary>
public interface ISyntaxNode
{
    /// <summary>Gets the grammar node type, for example "function_definition".</summary>
    string Type { get; }

    /// <summary>Gets the node text.</summary>
    string Text { get; }

    /// <summary>Gets the 1-based start line.</summary>
    int StartLine { get; }

    /// <summary>Gets the 1-based end line.</summary>
    int EndLine { get; }

    /// <summary>Gets the named children.</summary>
    IReadOnlyList<ISyntaxNode> Children { get; }

    /// <summary>Gets a child by grammar field name.</summary>
    /// <param name="fieldName">The field name.</param>
    ISyntaxNode? Field(string fieldName);
}

/// <summary>Parses text with a grammar. Implementations wrap a native tree-sitter binding; none ships yet.</summary>
public interface ITreeSitterParser
{
    /// <summary>Parses a source text.</summary>
    /// <param name="text">The text.</param>
    ISyntaxNode Parse(string text);
}

/// <summary>
/// Base adapter for languages without a dedicated compiler API. A derived class maps a grammar's syntax
/// nodes to IR declarations; parsing, comment collection and result assembly live here. Without semantic
/// information, symbols stay unresolved, so analyzers lower their confidence accordingly.
/// </summary>
/// <param name="parser">Parser for the grammar.</param>
public abstract class TreeSitterAdapterBase(ITreeSitterParser parser) : ILanguageAdapter
{
    /// <inheritdoc />
    public abstract string Language { get; }

    /// <inheritdoc />
    public abstract IReadOnlyList<string> FileExtensions { get; }

    /// <inheritdoc />
    public abstract IReadOnlyList<string> SupportedParadigms { get; }

    /// <inheritdoc />
    public virtual IReadOnlyList<string> DefaultParadigms => SupportedParadigms;

    /// <summary>Gets grammar node types that are comments.</summary>
    protected virtual IReadOnlyCollection<string> CommentNodeTypes { get; } = ["comment"];

    /// <summary>Maps a parsed file to IR modules.</summary>
    /// <param name="path">Relative file path.</param>
    /// <param name="root">Tree root.</param>
    protected abstract IEnumerable<ModuleDecl> MapFile(string path, ISyntaxNode root);

    /// <inheritdoc />
    public Task<AdapterResult> LoadAsync(IReadOnlyList<SourceInput> sources, CancellationToken cancellationToken)
    {
        var modules = new List<ModuleDecl>();
        var files = new List<SourceFile>();
        foreach (var source in sources)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var root = parser.Parse(source.Text);
            var comments = Descend(root).Where(n => CommentNodeTypes.Contains(n.Type))
                .Select(n => new CommentInfo(n.Text, new SourceLocation(source.Path, n.StartLine, 1, n.EndLine, 1), false)).ToList();
            files.Add(new SourceFile(source.Path, Language, source.Text) { Comments = comments });
            modules.AddRange(MapFile(source.Path, root));
        }
        return Task.FromResult(new AdapterResult(modules, files, []));
    }

    private static IEnumerable<ISyntaxNode> Descend(ISyntaxNode node) => node.Children.SelectMany(Descend).Prepend(node);
}
