using System.Text.Json;
using Nomos.Abstractions;
using Nomos.Core;

namespace Nomos.Cli;

/// <summary>Command-line entry point.</summary>
public static class Program
{
    private const int Success = 0;
    private const int UsageError = 2;

    private const string Usage = """
        Nomos: static inspection of source code.

        Usage:
          nomos analyze <path> [options]   Analyze a folder, .sln, .slnx or .csproj.
          nomos list-analyzers             List discovered analyzers.
          nomos init [folder]              Write a starter nomos.json.

        Options:
          --config <file>        Configuration file (default: <path>/nomos.json).
          --format <list>        Report formats, comma-separated: json,md,html,sarif (default: md).
          --output <folder>      Report folder (default: nomos-report).
          --plugins <folder>     Plugin folder (default: <path>/plugins, as set in configuration).
          --quiet                Print only the final line.

        Exit codes: 0 success, 2 usage or configuration error.
        """;

    /// <summary>Runs the tool.</summary>
    /// <param name="args">Command-line arguments.</param>
    public static async Task<int> Main(string[] args)
    {
        try
        {
            return args switch
            {
                ["analyze", var path, .. var rest] => await AnalyzeAsync(path, Options.Parse(rest)).ConfigureAwait(false),
                ["list-analyzers", ..] => ListAnalyzers(),
                ["init"] => Init(Directory.GetCurrentDirectory()),
                ["init", var folder] => Init(folder),
                _ => Help(args),
            };
        }
        catch (ConfigurationException exception)
        {
            await Console.Error.WriteLineAsync($"error: {exception.Message}").ConfigureAwait(false);
            return UsageError;
        }
    }

    private static int Help(string[] args)
    {
        Console.Out.WriteLine(Usage);
        return args is [] or ["--help"] or ["-h"] ? Success : UsageError;
    }

    private static async Task<int> AnalyzeAsync(string path, Options options)
    {
        var root = Directory.Exists(path) ? path : Path.GetDirectoryName(Path.GetFullPath(path)) ?? ".";
        var config = options.ConfigPath is { } file ? NomosConfig.Load(file) : NomosConfig.LoadOrDefault(root);

        var catalog = ComponentCatalog.Discover(PluginLoader.LoadBuiltIn());
        var pluginDiagnostics = new List<ToolDiagnostic>();
        foreach (var plugin in PluginLoader.LoadPlugins(options.PluginsPath ?? Path.Combine(root, config.PluginsPath), pluginDiagnostics)) catalog.Add(plugin);
        foreach (var diagnostic in pluginDiagnostics) Console.Error.WriteLine($"{diagnostic.Level}: {diagnostic.Message}");

        var progress = options.Quiet ? null : new Progress<string>(message => Console.Error.WriteLine(message));
        using var cancellation = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            cancellation.Cancel();
        };
        var result = await new AnalysisEngine(catalog).RunAsync(new AnalysisRequest { Path = path, Config = config, Progress = progress }, cancellation.Token).ConfigureAwait(false);

        Directory.CreateDirectory(options.Output);
        foreach (var format in options.Formats)
        {
            var writer = catalog.ReportWriters.FirstOrDefault(w => string.Equals(w.Format, format, StringComparison.OrdinalIgnoreCase))
                ?? throw new ConfigurationException($"Unknown report format '{format}'. Available: {string.Join(", ", catalog.ReportWriters.Select(w => w.Format))}.");
            var target = Path.Combine(options.Output, "nomos" + writer.FileExtension);
            await using var stream = new StreamWriter(target);
            writer.Write(result, stream);
            if (!options.Quiet) Console.Out.WriteLine($"Report: {target}");
        }

        foreach (var diagnostic in result.Diagnostics.Where(d => d.Level == DiagnosticLevel.Error)) Console.Error.WriteLine($"error ({diagnostic.Source}): {diagnostic.Message}");
        Console.Out.WriteLine(FormattableString.Invariant($"Health {result.Health.Score:0.0}, {result.Findings.Count} findings, {result.FileCount} files."));
        return Success;
    }

    private static int ListAnalyzers()
    {
        var catalog = ComponentCatalog.Discover(PluginLoader.LoadBuiltIn());
        foreach (var descriptor in catalog.Analyzers.Select(a => a.Descriptor).OrderBy(d => d.Id, StringComparer.Ordinal))
        {
            var paradigms = descriptor.Paradigms.Count == 0 ? "any" : string.Join(",", descriptor.Paradigms);
            var languages = descriptor.Languages.Count == 0 ? "any" : string.Join(",", descriptor.Languages);
            Console.Out.WriteLine($"{descriptor.Id,-8} {descriptor.Category,-16} {descriptor.DefaultSeverity,-9} {paradigms,-26} {languages,-8} {descriptor.Title}");
        }
        return Success;
    }

    private static int Init(string folder)
    {
        var path = Path.Combine(folder, NomosConfig.FileName);
        if (File.Exists(path)) throw new ConfigurationException($"{path} already exists.");
        var starter = new NomosConfig
        {
            Languages = { [Abstractions.Languages.CSharp] = new LanguageConfig { Paradigms = [Paradigms.ObjectOriented, Paradigms.Structural] } },
            Exclude = ["**/tests/**"],
        };
        File.WriteAllText(path, JsonSerializer.Serialize(starter, NomosConfig.SerializerOptions));
        Console.Out.WriteLine($"Created {path}");
        return Success;
    }

    private sealed record Options
    {
        public string? ConfigPath { get; private init; }

        public IReadOnlyList<string> Formats { get; private init; } = ["md"];

        public string Output { get; private init; } = "nomos-report";

        public string? PluginsPath { get; private init; }

        public bool Quiet { get; private init; }

        public static Options Parse(ReadOnlySpan<string> args)
        {
            var options = new Options();
            for (var i = 0; i < args.Length; i++)
            {
                var name = args[i];
                if (name == "--quiet")
                {
                    options = options with { Quiet = true };
                    continue;
                }
                if (i + 1 >= args.Length) throw new ConfigurationException($"Missing value for {name}.");
                var value = args[++i];
                options = name switch
                {
                    "--config" => options with { ConfigPath = value },
                    "--format" => options with { Formats = value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries) },
                    "--output" => options with { Output = value },
                    "--plugins" => options with { PluginsPath = value },
                    _ => throw new ConfigurationException($"Invalid option: {name} {value}"),
                };
            }
            return options;
        }
    }
}
