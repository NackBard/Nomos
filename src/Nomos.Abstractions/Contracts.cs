using System.Security.Cryptography;
using System.Text;
using Nomos.Abstractions.Ir;

namespace Nomos.Abstractions;

/// <summary>Well-known language identifiers. Any other string is a valid identifier too.</summary>
public static class Languages
{
    /// <summary>C#.</summary>
    public const string CSharp = "csharp";
}

/// <summary>Well-known paradigm identifiers. Any other string is a valid identifier too.</summary>
public static class Paradigms
{
    /// <summary>Object-oriented programming.</summary>
    public const string ObjectOriented = "oop";
    /// <summary>Functional programming.</summary>
    public const string Functional = "functional";
    /// <summary>Structural or procedural programming.</summary>
    public const string Structural = "structural";
}

/// <summary>Well-known analyzer categories. Any other string is a valid category too.</summary>
public static class Categories
{
    /// <summary>Design principles: SOLID, DRY, KISS, YAGNI, Law of Demeter.</summary>
    public const string Principles = "Principles";
    /// <summary>Readability and code hygiene.</summary>
    public const string CleanCode = "CleanCode";
    /// <summary>Paradigm-specific fundamentals.</summary>
    public const string Paradigm = "Paradigm";
    /// <summary>Estimated algorithmic complexity.</summary>
    public const string Algorithms = "Algorithms";
    /// <summary>Architecture and package design.</summary>
    public const string Design = "Design";
    /// <summary>Design patterns and antipatterns.</summary>
    public const string Patterns = "Patterns";
    /// <summary>Maintainability metrics.</summary>
    public const string Maintainability = "Maintainability";
    /// <summary>Baseline security heuristics.</summary>
    public const string Security = "Security";
}

/// <summary>How much a finding matters.</summary>
public enum Severity
{
    /// <summary>Informational; no penalty by default.</summary>
    Info,
    /// <summary>A small issue.</summary>
    Minor,
    /// <summary>An issue worth fixing.</summary>
    Major,
    /// <summary>A serious issue.</summary>
    Critical,
}

/// <summary>How likely a heuristic is to be right. No finding is a proven verdict.</summary>
public enum Confidence
{
    /// <summary>Weak signal; review before acting.</summary>
    Low,
    /// <summary>Probable.</summary>
    Medium,
    /// <summary>Very likely.</summary>
    High,
}

/// <summary>The proof attached to a finding.</summary>
/// <param name="Location">Where it is.</param>
/// <param name="Snippet">Code fragment.</param>
/// <param name="Explanation">Why the analyzer believes this; mandatory.</param>
public sealed record Evidence(SourceLocation Location, string Snippet, string Explanation);

/// <summary>A single analyzer result.</summary>
/// <param name="AnalyzerId">Reporting analyzer.</param>
/// <param name="Category">Analyzer category.</param>
/// <param name="Severity">Effective severity.</param>
/// <param name="Confidence">Confidence level.</param>
/// <param name="Message">One-line summary.</param>
/// <param name="Evidence">Proof.</param>
public sealed record Finding(string AnalyzerId, string Category, Severity Severity, Confidence Confidence, string Message, Evidence Evidence)
{
    /// <summary>Gets the module the finding belongs to.</summary>
    public string? Module { get; init; }

    /// <summary>Gets the identifier of the type or callable the finding is about.</summary>
    public string? Symbol { get; init; }

    /// <summary>Gets a hash that survives line shifts, for baselines and IDE tracking.</summary>
    public string Fingerprint
    {
        get
        {
            var key = $"{AnalyzerId}|{Evidence.Location.FilePath}|{Symbol}|{Message}";
            return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..16];
        }
    }
}

/// <summary>Level a metric is measured at.</summary>
public enum MetricScope
{
    /// <summary>Whole project.</summary>
    Project,
    /// <summary>A module.</summary>
    Module,
    /// <summary>A type.</summary>
    Type,
    /// <summary>A callable.</summary>
    Callable,
}

/// <summary>A measured value.</summary>
/// <param name="Id">Metric identifier, for example "cyclomatic".</param>
/// <param name="Scope">Measurement level.</param>
/// <param name="Target">Identifier of the measured entity.</param>
/// <param name="Value">Value.</param>
/// <param name="Module">Owning module, when any.</param>
public sealed record Metric(string Id, MetricScope Scope, string Target, double Value, string? Module = null);

/// <summary>Immutable description of an analyzer.</summary>
/// <param name="Id">Stable identifier.</param>
/// <param name="Title">Human-readable title.</param>
/// <param name="Category">Category.</param>
/// <param name="Description">What it checks and how.</param>
/// <param name="DefaultSeverity">Severity unless configured otherwise.</param>
/// <param name="Languages">Supported languages; empty means any language.</param>
/// <param name="Paradigms">Paradigm profiles; empty means it always applies.</param>
public sealed record AnalyzerDescriptor(
    string Id,
    string Title,
    string Category,
    string Description,
    Severity DefaultSeverity,
    IReadOnlyList<string> Languages,
    IReadOnlyList<string> Paradigms)
{
    /// <summary>Gets whether the analyzer runs when nothing configures it.</summary>
    public bool EnabledByDefault { get; init; } = true;
}

/// <summary>Marks a class as a discoverable analyzer.</summary>
/// <param name="id">Stable identifier.</param>
/// <param name="category">Category.</param>
[AttributeUsage(AttributeTargets.Class, Inherited = false)]
public sealed class AnalyzerAttribute(string id, string category) : Attribute
{
    /// <summary>Gets the identifier.</summary>
    public string Id { get; } = id;

    /// <summary>Gets the category.</summary>
    public string Category { get; } = category;

    /// <summary>Gets or sets the title.</summary>
    public string Title { get; set; } = "";

    /// <summary>Gets or sets the description.</summary>
    public string Description { get; set; } = "";

    /// <summary>Gets or sets the default severity.</summary>
    public Severity Severity { get; set; } = Severity.Minor;

    /// <summary>Gets or sets supported languages; empty means any.</summary>
    public string[] Languages { get; set; } = [];

    /// <summary>Gets or sets paradigms; empty means always.</summary>
    public string[] Paradigms { get; set; } = [];

    /// <summary>Gets or sets whether the analyzer is enabled without configuration.</summary>
    public bool EnabledByDefault { get; set; } = true;
}

/// <summary>Reads analyzer settings. Each accessor takes the built-in default, so that thresholds stay next to the rule.</summary>
public interface IAnalyzerOptions
{
    /// <summary>Gets an integer threshold.</summary>
    /// <param name="key">Threshold key.</param>
    /// <param name="fallback">Built-in default.</param>
    int Int(string key, int fallback);

    /// <summary>Gets a numeric threshold.</summary>
    /// <param name="key">Threshold key.</param>
    /// <param name="fallback">Built-in default.</param>
    double Number(string key, double fallback);

    /// <summary>Gets a text setting.</summary>
    /// <param name="key">Setting key.</param>
    /// <param name="fallback">Built-in default.</param>
    string Text(string key, string fallback);

    /// <summary>Gets a list setting.</summary>
    /// <param name="key">Setting key.</param>
    /// <param name="fallback">Built-in default.</param>
    IReadOnlyList<string> List(string key, IReadOnlyList<string> fallback);
}

/// <summary>A layer in the intended architecture.</summary>
/// <param name="Name">Layer name.</param>
/// <param name="Patterns">Module name glob patterns, for example "*.Domain*".</param>
/// <param name="MayDependOn">Names of layers this layer may depend on.</param>
public sealed record LayerRule(string Name, IReadOnlyList<string> Patterns, IReadOnlyList<string> MayDependOn);

/// <summary>Everything a single analyzer run sees.</summary>
public sealed class AnalysisContext
{
    private readonly Action<Finding> _onFinding;
    private readonly Action<Metric> _onMetric;
    private readonly AnalyzerDescriptor _descriptor;

    /// <summary>Initializes a new instance. Called by the engine and by test hosts.</summary>
    /// <param name="descriptor">Running analyzer.</param>
    /// <param name="model">Project model.</param>
    /// <param name="modules">Modules of the language under analysis.</param>
    /// <param name="language">Language under analysis.</param>
    /// <param name="paradigms">Active paradigms.</param>
    /// <param name="options">Analyzer options.</param>
    /// <param name="shared">Per-run cache shared between analyzers.</param>
    /// <param name="onFinding">Finding sink.</param>
    /// <param name="onMetric">Metric sink.</param>
    public AnalysisContext(
        AnalyzerDescriptor descriptor,
        ProjectModel model,
        IReadOnlyList<ModuleDecl> modules,
        string language,
        IReadOnlySet<string> paradigms,
        IAnalyzerOptions options,
        ISharedAnalysisData shared,
        Action<Finding> onFinding,
        Action<Metric> onMetric)
    {
        _descriptor = descriptor;
        Model = model;
        Modules = modules;
        Language = language;
        ActiveParadigms = paradigms;
        Options = options;
        Shared = shared;
        _onFinding = onFinding;
        _onMetric = onMetric;
    }

    /// <summary>Gets the whole project model.</summary>
    public ProjectModel Model { get; }

    /// <summary>Gets the modules to analyze in this run.</summary>
    public IReadOnlyList<ModuleDecl> Modules { get; }

    /// <summary>Gets the language under analysis.</summary>
    public string Language { get; }

    /// <summary>Gets the active paradigms.</summary>
    public IReadOnlySet<string> ActiveParadigms { get; }

    /// <summary>Gets analyzer options.</summary>
    public IAnalyzerOptions Options { get; }

    /// <summary>Gets data computed once per analysis and shared between analyzers.</summary>
    public ISharedAnalysisData Shared { get; }

    /// <summary>Gets configured architecture layers.</summary>
    public IReadOnlyList<LayerRule> Layers { get; init; } = [];

    /// <summary>Gets the root directory of the analysis, when it runs from disk.</summary>
    public string? RootPath { get; init; }

    /// <summary>Gets or sets the token that cancels the analysis.</summary>
    public CancellationToken CancellationToken { get; init; }

    /// <summary>Gets all types of the modules in this run.</summary>
    public IEnumerable<TypeDecl> Types => Modules.SelectMany(m => m.AllTypes);

    /// <summary>Gets all callables of the modules in this run.</summary>
    public IEnumerable<Callable> Callables => Modules.SelectMany(m => m.AllCallables);

    /// <summary>Reports a finding. The explanation is mandatory: no heuristic may be presented as a bare verdict.</summary>
    /// <param name="confidence">Confidence level.</param>
    /// <param name="location">Where it is.</param>
    /// <param name="message">One-line summary.</param>
    /// <param name="explanation">Why the analyzer believes this.</param>
    /// <param name="module">Owning module.</param>
    /// <param name="symbol">Identifier of the type or callable.</param>
    /// <param name="severity">Severity, when it differs from the analyzer default.</param>
    public void Report(
        Confidence confidence,
        SourceLocation location,
        string message,
        string explanation,
        string? module = null,
        string? symbol = null,
        Severity? severity = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(message);
        ArgumentException.ThrowIfNullOrWhiteSpace(explanation);
        var snippet = Model.FindFile(location.FilePath)?.Excerpt(location) ?? string.Empty;
        _onFinding(new Finding(_descriptor.Id, _descriptor.Category, severity ?? _descriptor.DefaultSeverity, confidence, message,
            new Evidence(location, snippet, explanation)) { Module = module, Symbol = symbol });
    }

    /// <summary>Reports a finding about a type.</summary>
    /// <param name="type">The type.</param>
    /// <param name="confidence">Confidence level.</param>
    /// <param name="message">One-line summary.</param>
    /// <param name="explanation">Why the analyzer believes this.</param>
    /// <param name="severity">Severity override.</param>
    public void Report(TypeDecl type, Confidence confidence, string message, string explanation, Severity? severity = null) =>
        Report(confidence, type.Location, message, explanation, type.ModuleName, type.Id, severity);

    /// <summary>Reports a metric.</summary>
    /// <param name="metric">The metric.</param>
    public void Report(Metric metric) => _onMetric(metric);
}

/// <summary>Per-run cache for expensive derived data, such as dependency graphs.</summary>
public interface ISharedAnalysisData
{
    /// <summary>Gets a value, computing it once.</summary>
    /// <typeparam name="T">Value type.</typeparam>
    /// <param name="key">Cache key.</param>
    /// <param name="factory">Value factory.</param>
    T GetOrAdd<T>(string key, Func<T> factory) where T : class;
}

/// <summary>A check over the IR.</summary>
public interface IAnalyzer
{
    /// <summary>Gets the analyzer description.</summary>
    AnalyzerDescriptor Descriptor { get; }

    /// <summary>Runs the analyzer; results go through <paramref name="context"/>.</summary>
    /// <param name="context">The analysis context.</param>
    void Analyze(AnalysisContext context);
}

/// <summary>Convenience base class taking the descriptor from <see cref="AnalyzerAttribute"/>.</summary>
public abstract class AnalyzerBase : IAnalyzer
{
    /// <summary>Initializes the descriptor from the attribute.</summary>
    protected AnalyzerBase()
    {
        var attribute = GetType().GetCustomAttributes(typeof(AnalyzerAttribute), false).Cast<AnalyzerAttribute>().SingleOrDefault()
            ?? throw new InvalidOperationException($"{GetType().FullName} has no [Analyzer] attribute.");
        Descriptor = new AnalyzerDescriptor(attribute.Id, attribute.Title.Length > 0 ? attribute.Title : attribute.Id, attribute.Category,
            attribute.Description, attribute.Severity, attribute.Languages, attribute.Paradigms)
        { EnabledByDefault = attribute.EnabledByDefault };
    }

    /// <inheritdoc />
    public AnalyzerDescriptor Descriptor { get; }

    /// <inheritdoc />
    public abstract void Analyze(AnalysisContext context);
}

/// <summary>Severity level of a tool diagnostic.</summary>
public enum DiagnosticLevel
{
    /// <summary>Informational.</summary>
    Info,
    /// <summary>The result may be incomplete.</summary>
    Warning,
    /// <summary>A part of the analysis failed.</summary>
    Error,
}

/// <summary>A message about the analysis itself, not about the analyzed code.</summary>
/// <param name="Level">Level.</param>
/// <param name="Source">Component that produced it.</param>
/// <param name="Message">Text.</param>
public sealed record ToolDiagnostic(DiagnosticLevel Level, string Source, string Message);

/// <summary>A source text to analyze. Text may come from disk or from an unsaved editor buffer.</summary>
/// <param name="Path">Path relative to the root, with forward slashes.</param>
/// <param name="Text">File content.</param>
public sealed record SourceInput(string Path, string Text);

/// <summary>What an adapter produced.</summary>
/// <param name="Modules">Modules in IR form.</param>
/// <param name="Files">Files with lexical information.</param>
/// <param name="Diagnostics">Messages about the conversion.</param>
public sealed record AdapterResult(IReadOnlyList<ModuleDecl> Modules, IReadOnlyList<SourceFile> Files, IReadOnlyList<ToolDiagnostic> Diagnostics);

/// <summary>Turns sources of one language into IR.</summary>
public interface ILanguageAdapter
{
    /// <summary>Gets the language identifier.</summary>
    string Language { get; }

    /// <summary>Gets handled file extensions, with the dot.</summary>
    IReadOnlyList<string> FileExtensions { get; }

    /// <summary>Gets paradigms whose concepts this adapter can express in IR.</summary>
    IReadOnlyList<string> SupportedParadigms { get; }

    /// <summary>Gets the paradigms used when configuration does not choose any.</summary>
    IReadOnlyList<string> DefaultParadigms { get; }

    /// <summary>Converts sources to IR.</summary>
    /// <param name="sources">Sources of this language.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    Task<AdapterResult> LoadAsync(IReadOnlyList<SourceInput> sources, CancellationToken cancellationToken);
}

/// <summary>Optional adapter capability: expands project files, such as .sln, to source directories.</summary>
public interface IProjectFileExpander
{
    /// <summary>Gets whether a file is a project file of this language.</summary>
    /// <param name="path">File path.</param>
    bool CanExpand(string path);

    /// <summary>Gets the directories that contain the project sources.</summary>
    /// <param name="path">File path.</param>
    IReadOnlyList<string> ExpandToDirectories(string path);
}

/// <summary>Health of one scored entity.</summary>
/// <param name="Score">Score from 0 to 100.</param>
/// <param name="Categories">Per-category breakdown.</param>
/// <param name="Explanation">Plain-language derivation of the score.</param>
public sealed record HealthScore(double Score,IReadOnlyList<CategoryScore> Categories, IReadOnlyList<string> Explanation);

/// <summary>Score of a category inside a health score.</summary>
/// <param name="Category">Category.</param>
/// <param name="Score">Score from 0 to 100.</param>
/// <param name="Weight">Normalized weight.</param>
/// <param name="Penalty">Sum of finding penalties.</param>
/// <param name="FindingCount">Number of findings.</param>
public sealed record CategoryScore(string Category, double Score, double Weight, double Penalty, int FindingCount);

/// <summary>Health of a module.</summary>
/// <param name="Module">Module name.</param>
/// <param name="LinesOfCode">Size used for normalization.</param>
/// <param name="Health">Score.</param>
public sealed record ModuleHealth(string Module, int LinesOfCode, HealthScore Health);

/// <summary>Complete analysis outcome.</summary>
public sealed record AnalysisResult
{
    /// <summary>Gets the project name.</summary>
    public required string ProjectName { get; init; }

    /// <summary>Gets the tool version.</summary>
    public required string ToolVersion { get; init; }

    /// <summary>Gets analyzed languages.</summary>
    public required IReadOnlyList<string> Languages { get; init; }

    /// <summary>Gets active paradigms by language.</summary>
    public required IReadOnlyDictionary<string, IReadOnlyList<string>> ActiveParadigms { get; init; }

    /// <summary>Gets analyzed files.</summary>
    public required int FileCount { get; init; }

    /// <summary>Gets findings in deterministic order.</summary>
    public required IReadOnlyList<Finding> Findings { get; init; }

    /// <summary>Gets findings removed by suppressions.</summary>
    public required IReadOnlyList<Finding> Suppressed { get; init; }

    /// <summary>Gets metrics in deterministic order.</summary>
    public required IReadOnlyList<Metric> Metrics { get; init; }

    /// <summary>Gets analyzers that ran.</summary>
    public required IReadOnlyList<AnalyzerDescriptor> Analyzers { get; init; }

    /// <summary>Gets health per module.</summary>
    public required IReadOnlyList<ModuleHealth> Modules { get; init; }

    /// <summary>Gets project health.</summary>
    public required HealthScore Health { get; init; }

    /// <summary>Gets messages about the analysis itself.</summary>
    public required IReadOnlyList<ToolDiagnostic> Diagnostics { get; init; }
}

/// <summary>Renders an analysis result.</summary>
public interface IReportWriter
{
    /// <summary>Gets the format name used on the command line.</summary>
    string Format { get; }

    /// <summary>Gets the output file extension, with the dot.</summary>
    string FileExtension { get; }

    /// <summary>Writes the report.</summary>
    /// <param name="result">Analysis result.</param>
    /// <param name="output">Output.</param>
    void Write(AnalysisResult result, TextWriter output);
}
