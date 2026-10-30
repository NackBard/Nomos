using System.Reflection;
using System.Runtime.Loader;
using Nomos.Abstractions;

namespace Nomos.Core;

/// <summary>Everything discovered from assemblies: analyzers, language adapters and report writers.</summary>
public sealed class ComponentCatalog
{
    private readonly List<IAnalyzer> _analyzers = [];
    private readonly List<ILanguageAdapter> _adapters = [];
    private readonly List<IReportWriter> _writers = [];
    private readonly List<ToolDiagnostic> _diagnostics = [];

    /// <summary>Gets the analyzers.</summary>
    public IReadOnlyList<IAnalyzer> Analyzers => _analyzers;

    /// <summary>Gets the language adapters.</summary>
    public IReadOnlyList<ILanguageAdapter> Adapters => _adapters;

    /// <summary>Gets the report writers.</summary>
    public IReadOnlyList<IReportWriter> ReportWriters => _writers;

    /// <summary>Gets messages produced during discovery.</summary>
    public IReadOnlyList<ToolDiagnostic> Diagnostics => _diagnostics;

    /// <summary>Discovers components in assemblies.</summary>
    /// <param name="assemblies">Assemblies to scan.</param>
    public static ComponentCatalog Discover(IEnumerable<Assembly> assemblies)
    {
        var catalog = new ComponentCatalog();
        foreach (var assembly in assemblies.Distinct()) catalog.Add(assembly);
        return catalog;
    }

    /// <summary>Scans an assembly and adds what it finds. A broken plugin yields a diagnostic, not a crash.</summary>
    /// <param name="assembly">The assembly.</param>
    public void Add(Assembly assembly)
    {
        Type[] types;
        try
        {
            types = assembly.GetTypes();
        }
        catch (ReflectionTypeLoadException exception)
        {
            _diagnostics.Add(new(DiagnosticLevel.Warning, "catalog", $"{assembly.GetName().Name}: some types failed to load: {exception.LoaderExceptions.FirstOrDefault()?.Message}"));
            types = [.. exception.Types.OfType<Type>()];
        }

        foreach (var type in types.Where(t => t is { IsClass: true, IsAbstract: false } && t.GetConstructor(Type.EmptyTypes) is not null))
        {
            try
            {
                if (type.IsDefined(typeof(AnalyzerAttribute), false) && typeof(IAnalyzer).IsAssignableFrom(type)) AddAnalyzer((IAnalyzer)Activator.CreateInstance(type)!);
                else if (typeof(ILanguageAdapter).IsAssignableFrom(type)) _adapters.Add((ILanguageAdapter)Activator.CreateInstance(type)!);
                else if (typeof(IReportWriter).IsAssignableFrom(type)) _writers.Add((IReportWriter)Activator.CreateInstance(type)!);
            }
            catch (Exception exception) when (exception is TargetInvocationException or MissingMethodException or InvalidOperationException)
            {
                _diagnostics.Add(new(DiagnosticLevel.Error, "catalog", $"{type.FullName}: {exception.GetBaseException().Message}"));
            }
        }
    }

    /// <summary>Gets a copy limited to the analyzers that satisfy a predicate.</summary>
    /// <param name="predicate">The predicate.</param>
    public ComponentCatalog Filter(Func<AnalyzerDescriptor, bool> predicate)
    {
        var copy = new ComponentCatalog();
        copy._analyzers.AddRange(_analyzers.Where(a => predicate(a.Descriptor)));
        copy._adapters.AddRange(_adapters);
        copy._writers.AddRange(_writers);
        return copy;
    }

    private void AddAnalyzer(IAnalyzer analyzer)
    {
        if (_analyzers.Any(a => string.Equals(a.Descriptor.Id, analyzer.Descriptor.Id, StringComparison.OrdinalIgnoreCase)))
            _diagnostics.Add(new(DiagnosticLevel.Error, "catalog", $"Duplicate analyzer id {analyzer.Descriptor.Id}: {analyzer.GetType().FullName} was ignored."));
        else
            _analyzers.Add(analyzer);
    }
}

/// <summary>Loads component assemblies.</summary>
public static class PluginLoader
{
    /// <summary>Loads Nomos.* assemblies that were deployed next to the host, so adding a project needs no code change.</summary>
    /// <param name="directory">Host directory; defaults to the application base directory.</param>
    public static IReadOnlyList<Assembly> LoadBuiltIn(string? directory = null)
    {
        var assemblies = new List<Assembly>();
        foreach (var file in Directory.GetFiles(directory ?? AppContext.BaseDirectory, "Nomos.*.dll").Order(StringComparer.Ordinal))
            assemblies.Add(AssemblyLoadContext.Default.LoadFromAssemblyName(AssemblyName.GetAssemblyName(file)));
        return assemblies;
    }

    /// <summary>Loads external plugins, each into its own load context, so their dependencies do not collide.</summary>
    /// <param name="directory">The plugin directory; a missing directory yields nothing.</param>
    /// <param name="diagnostics">Receives load failures.</param>
    public static IReadOnlyList<Assembly> LoadPlugins(string directory, ICollection<ToolDiagnostic> diagnostics)
    {
        var assemblies = new List<Assembly>();
        if (!Directory.Exists(directory)) return assemblies;
        foreach (var file in Directory.GetFiles(directory, "*.dll").Order(StringComparer.Ordinal))
        {
            try
            {
                assemblies.Add(new PluginLoadContext(Path.GetFullPath(file)).LoadFromAssemblyPath(Path.GetFullPath(file)));
            }
            catch (Exception exception) when (exception is IOException or BadImageFormatException or FileLoadException)
            {
                diagnostics.Add(new(DiagnosticLevel.Warning, "plugins", $"{Path.GetFileName(file)}: {exception.Message}"));
            }
        }
        return assemblies;
    }

    private sealed class PluginLoadContext(string pluginPath) : AssemblyLoadContext(Path.GetFileNameWithoutExtension(pluginPath))
    {
        private readonly AssemblyDependencyResolver _resolver = new(pluginPath);

        protected override Assembly? Load(AssemblyName assemblyName)
        {
            // Contracts must stay shared with the host, otherwise type identity breaks.
            if (Default.Assemblies.Any(a => a.GetName().Name == assemblyName.Name)) return null;
            var path = _resolver.ResolveAssemblyToPath(assemblyName);
            return path is null ? null : LoadFromAssemblyPath(path);
        }
    }
}
