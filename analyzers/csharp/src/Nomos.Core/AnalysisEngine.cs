using System.Collections.Concurrent;
using System.Reflection;
using Nomos.Abstractions;
using Nomos.Abstractions.Ir;

namespace Nomos.Core;

/// <summary>What to analyze.</summary>
public sealed record AnalysisRequest
{
    /// <summary>Gets the directory or project file to analyze.</summary>
    public string? Path { get; init; }

    /// <summary>Gets in-memory sources per language; when set, nothing is read from disk. Hosts such as IDEs pass editor buffers here.</summary>
    public IReadOnlyDictionary<string, IReadOnlyList<SourceInput>>? Sources { get; init; }

    /// <summary>Gets the project name; defaults to the name of the analyzed path.</summary>
    public string? ProjectName { get; init; }

    /// <summary>Gets the configuration.</summary>
    public NomosConfig Config { get; init; } = new();

    /// <summary>Gets a callback for progress messages.</summary>
    public IProgress<string>? Progress { get; init; }
}

/// <summary>Runs adapters and analyzers and turns the outcome into an <see cref="AnalysisResult"/>.</summary>
/// <param name="catalog">Available components.</param>
public sealed class AnalysisEngine(ComponentCatalog catalog)
{
    /// <summary>Runs an analysis.</summary>
    /// <param name="request">The request.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    public async Task<AnalysisResult> RunAsync(AnalysisRequest request, CancellationToken cancellationToken = default)
    {
        var config = request.Config;
        var diagnostics = new ConcurrentBag<ToolDiagnostic>();
        var root = request.Path is null ? null : ResolveRoot(request.Path);

        request.Progress?.Report("Collecting sources");
        var sources = request.Sources ?? SourceCollector.Collect(request.Path!, Adapters(config), config);

        var modules = new List<ModuleDecl>();
        var files = new List<SourceFile>();
        var languages = new List<string>();
        foreach (var (language, inputs) in sources.OrderBy(p => p.Key, StringComparer.Ordinal))
        {
            var adapter = catalog.Adapters.FirstOrDefault(a => a.Language == language);
            if (adapter is null)
            {
                diagnostics.Add(new(DiagnosticLevel.Warning, "engine", $"No adapter for language '{language}'."));
                continue;
            }
            request.Progress?.Report($"Parsing {inputs.Count} {language} file(s)");
            var adapted = await adapter.LoadAsync(inputs, cancellationToken).ConfigureAwait(false);
            modules.AddRange(adapted.Modules);
            files.AddRange(adapted.Files);
            foreach (var diagnostic in adapted.Diagnostics) diagnostics.Add(diagnostic);
            languages.Add(language);
        }

        var name = request.ProjectName ?? (root is null ? "project" : System.IO.Path.GetFileNameWithoutExtension(request.Path!.TrimEnd('/', '\\')));
        var model = new ProjectModel(name, modules, files);
        var shared = new SharedAnalysisData();
        var findings = new ConcurrentBag<Finding>();
        var metrics = new ConcurrentBag<Metric>();
        var ran = new ConcurrentDictionary<string, AnalyzerDescriptor>();
        var activeParadigms = new Dictionary<string, IReadOnlyList<string>>();

        foreach (var language in languages)
        {
            var paradigms = ActiveParadigms(language, config, diagnostics);
            activeParadigms[language] = [.. paradigms.Order(StringComparer.Ordinal)];
            var languageModules = modules.Where(m => m.Language == language).ToList();
            // Paradigm signs per module: a rule bound to paradigms sees only the modules where one of them shows (spec/paradigms.md).
            var activeIn = languageModules.ToDictionary(m => m.Name, m => ParadigmSigns.ActiveParadigms(ParadigmSigns.Collect(model, m)), StringComparer.Ordinal);
            var eligible = catalog.Analyzers.Where(a => IsEligible(a.Descriptor, language, paradigms, config)).ToList();
            request.Progress?.Report($"Running {eligible.Count} analyzer(s) on {language}");

            await Parallel.ForEachAsync(eligible, cancellationToken, (analyzer, token) =>
            {
                ran[analyzer.Descriptor.Id] = analyzer.Descriptor;
                var visibleModules = analyzer.Descriptor.Paradigms.Count == 0
                    ? languageModules
                    : [.. languageModules.Where(m => ParadigmSigns.Applies(analyzer.Descriptor.Paradigms, activeIn[m.Name]))];
                var context = new AnalysisContext(analyzer.Descriptor, model, visibleModules, language, paradigms,
                    new AnalyzerOptions(config.Analyzers.GetValueOrDefault(analyzer.Descriptor.Id)), shared, findings.Add, metrics.Add)
                {
                    Layers = config.Layers,
                    RootPath = root,
                    CancellationToken = token,
                };
                try
                {
                    analyzer.Analyze(context);
                }
                catch (Exception exception) when (exception is not OperationCanceledException)
                {
                    diagnostics.Add(new(DiagnosticLevel.Error, analyzer.Descriptor.Id, $"Analyzer failed: {exception.GetType().Name}: {exception.Message}"));
                }
                return ValueTask.CompletedTask;
            }).ConfigureAwait(false);
        }

        request.Progress?.Report("Scoring");
        var moduleOfFile = BuildFileIndex(modules);
        var filter = new SuppressionFilter(model, config.Suppressions);
        var effective = findings
            .Select(f => ApplyOverrides(f, config, moduleOfFile))
            .Distinct()
            .OrderBy(f => f.Evidence.Location.FilePath, StringComparer.Ordinal)
            .ThenBy(f => f.Evidence.Location.StartLine)
            .ThenBy(f => f.Evidence.Location.StartColumn)
            .ThenBy(f => f.AnalyzerId, StringComparer.Ordinal)
            .ThenBy(f => f.Message, StringComparer.Ordinal)
            .ToList();
        var kept = effective.Where(f => !filter.IsSuppressed(f)).ToList();
        var suppressed = effective.Except(kept).ToList();

        var scorer = new HealthScorer(config.Scoring);
        var categories = ran.Values.Select(d => d.Category).Distinct().ToList();
        var moduleHealth = scorer.ScoreModules(modules.OrderBy(m => m.Name, StringComparer.Ordinal).Select(m => (m.Name, m.LinesOfCode)), kept, categories);

        return new AnalysisResult
        {
            ProjectName = name,
            ToolVersion = typeof(AnalysisEngine).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0] ?? "0.0.0",
            Languages = languages,
            ActiveParadigms = activeParadigms,
            FileCount = files.Count,
            Findings = kept,
            Suppressed = suppressed,
            Metrics = [.. metrics.Distinct().OrderBy(m => m.Id, StringComparer.Ordinal).ThenBy(m => m.Scope).ThenBy(m => m.Target, StringComparer.Ordinal)],
            Analyzers = [.. ran.Values.OrderBy(d => d.Id, StringComparer.Ordinal)],
            Modules = moduleHealth,
            Health = scorer.ScoreProject(moduleHealth),
            Diagnostics = [.. diagnostics.OrderByDescending(d => d.Level).ThenBy(d => d.Source, StringComparer.Ordinal).ThenBy(d => d.Message, StringComparer.Ordinal)],
            Model = model,
        };
    }

    private IEnumerable<ILanguageAdapter> Adapters(NomosConfig config) =>
        catalog.Adapters.Where(a => config.Languages.Count == 0 || config.Languages.ContainsKey(a.Language));

    private static string ResolveRoot(string path) =>
        Directory.Exists(path) ? System.IO.Path.GetFullPath(path) : System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(path))!;

    private HashSet<string> ActiveParadigms(string language, NomosConfig config, ConcurrentBag<ToolDiagnostic> diagnostics)
    {
        var adapter = catalog.Adapters.First(a => a.Language == language);
        var requested = config.Languages.TryGetValue(language, out var settings) && settings.Paradigms.Count > 0
            ? settings.Paradigms
            : (IReadOnlyList<string>)adapter.DefaultParadigms;
        var active = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var paradigm in requested)
        {
            if (adapter.SupportedParadigms.Contains(paradigm, StringComparer.OrdinalIgnoreCase)) active.Add(paradigm);
            else diagnostics.Add(new(DiagnosticLevel.Warning, "engine", $"Language '{language}' does not support paradigm '{paradigm}'; it was skipped."));
        }
        return active;
    }

    private static bool IsEligible(AnalyzerDescriptor descriptor, string language, HashSet<string> paradigms, NomosConfig config)
    {
        if (descriptor.Languages.Count > 0 && !descriptor.Languages.Contains(language, StringComparer.OrdinalIgnoreCase)) return false;
        if (descriptor.Paradigms.Count > 0 && !descriptor.Paradigms.Any(paradigms.Contains)) return false;
        if (config.Analyzers.TryGetValue(descriptor.Id, out var analyzer) && analyzer.Enabled is { } enabled) return enabled;
        if (config.Categories.TryGetValue(descriptor.Category, out var category) && category.Enabled is { } categoryEnabled) return categoryEnabled;
        return descriptor.EnabledByDefault;
    }

    private static Dictionary<string, string> BuildFileIndex(IEnumerable<ModuleDecl> modules)
    {
        var index = new Dictionary<string, string>();
        foreach (var module in modules)
            foreach (var type in module.AllTypes)
                index.TryAdd(type.Location.FilePath, module.Name);
        return index;
    }

    private static Finding ApplyOverrides(Finding finding, NomosConfig config, Dictionary<string, string> moduleOfFile)
    {
        var severity = config.Analyzers.GetValueOrDefault(finding.AnalyzerId)?.Severity ?? finding.Severity;
        var module = finding.Module ?? moduleOfFile.GetValueOrDefault(finding.Evidence.Location.FilePath);
        return finding with { Severity = severity, Module = module };
    }

    private sealed class SharedAnalysisData : ISharedAnalysisData
    {
        private readonly ConcurrentDictionary<string, Lazy<object>> _values = new();

        public T GetOrAdd<T>(string key, Func<T> factory) where T : class =>
            (T)_values.GetOrAdd(key, _ => new Lazy<object>(factory)).Value;
    }
}

/// <summary>Finds source files on disk for the available adapters.</summary>
public static class SourceCollector
{
    private static readonly string[] BuiltInExcludes =
    [
        "**/bin/**", "**/obj/**", "**/.git/**", "**/.vs/**", "**/node_modules/**",
        "**/*.g.cs", "**/*.Designer.cs", "**/*.AssemblyInfo.cs",
    ];

    /// <summary>Collects sources of every adapter, grouped by language.</summary>
    /// <param name="path">Directory or project file.</param>
    /// <param name="adapters">Adapters to collect for.</param>
    /// <param name="config">Include and exclude settings.</param>
    /// <exception cref="ConfigurationException">The path does not exist or no adapter can read the project file.</exception>
    public static IReadOnlyDictionary<string, IReadOnlyList<SourceInput>> Collect(string path, IEnumerable<ILanguageAdapter> adapters, NomosConfig config)
    {
        var adapterList = adapters.ToList();
        var fullPath = Path.GetFullPath(path);
        string root;
        IReadOnlyList<string> directories;
        if (Directory.Exists(fullPath))
        {
            root = fullPath;
            directories = [fullPath];
        }
        else if (File.Exists(fullPath))
        {
            var expander = adapterList.OfType<IProjectFileExpander>().FirstOrDefault(e => e.CanExpand(fullPath))
                ?? throw new ConfigurationException($"No adapter can read project file {path}.");
            root = Path.GetDirectoryName(fullPath)!;
            directories = expander.ExpandToDirectories(fullPath);
        }
        else
        {
            throw new ConfigurationException($"Path not found: {path}");
        }

        var result = new Dictionary<string, IReadOnlyList<SourceInput>>();
        var excludes = BuiltInExcludes.Concat(config.Exclude).ToList();
        var files = directories.SelectMany(d => Directory.EnumerateFiles(d, "*", SearchOption.AllDirectories)).Distinct()
            .Select(f => (Full: f, Relative: Path.GetRelativePath(root, f).Replace('\\', '/')))
            .Where(f => !excludes.Any(e => Glob.IsMatch(e, f.Relative)) && (config.Include.Count == 0 || config.Include.Any(i => Glob.IsMatch(i, f.Relative))))
            .OrderBy(f => f.Relative, StringComparer.Ordinal)
            .ToList();

        foreach (var adapter in adapterList)
        {
            var own = files.Where(f => adapter.FileExtensions.Contains(Path.GetExtension(f.Full), StringComparer.OrdinalIgnoreCase))
                .Select(f => new SourceInput(f.Relative, File.ReadAllText(f.Full))).ToList();
            if (own.Count > 0) result[adapter.Language] = own;
        }
        return result;
    }
}
