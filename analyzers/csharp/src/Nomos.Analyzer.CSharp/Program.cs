using System.Reflection;
using System.Text;
using System.Text.Json;
using Nomos.Abstractions;
using Nomos.Core;
using Nomos.Facts;

namespace Nomos.Analyzer.CSharp;

/// <summary>
/// Analyzer for C# speaking the Nomos protocol (docs/ARCHITECTURE.md): <c>manifest</c> and <c>analyze --root</c>.
/// Facts go to stdout, SARIF to the file named by <c>--sarif</c>, diagnostics for people to stderr.
/// </summary>
public static class Program
{
    private const int Success = 0;
    private const int Unexpected = 1;
    private const int UsageError = 2;
    private const int BadInput = 3;
    private const int Partial = 4;
    private const string Name = "nomos-csharp";
    private const string SchemaVersion = "1.1.0";

    /// <summary>Runs the analyzer.</summary>
    /// <param name="args">Command-line arguments.</param>
    public static async Task<int> Main(string[] args)
    {
        try
        {
            return args switch
            {
                ["manifest"] => Manifest(),
                ["analyze", .. var rest] => await AnalyzeAsync(rest).ConfigureAwait(false),
                _ => Usage($"Unknown command or option: {string.Join(' ', args)}"),
            };
        }
        catch (ConfigurationException exception)
        {
            await Console.Error.WriteLineAsync($"error: {exception.Message}").ConfigureAwait(false);
            return BadInput;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            await Console.Error.WriteLineAsync($"error: {exception}").ConfigureAwait(false);
            return Unexpected;
        }
    }

    private static string Version { get; } =
        typeof(Program).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0] ?? "0.0.0";

    private static int Usage(string message)
    {
        Console.Error.WriteLine($"{message}\nUsage: {Name} manifest | analyze --root <path> [--sarif <file>] [--config <nomos.json>] [--rules <ids>]");
        return UsageError;
    }

    private static int Manifest()
    {
        var descriptors = BuiltInComponents.Catalog().Analyzers.Select(a => a.Descriptor).OrderBy(d => d.Id, StringComparer.Ordinal).ToList();
        var manifest = new
        {
            name = Name,
            language = Abstractions.Languages.CSharp,
            version = Version,
            schemaVersion = SchemaVersion,
            paradigms = new[] { Paradigms.Functional, Paradigms.ObjectOriented, Paradigms.Structural },
            capabilities = new
            {
                semantic = true,
                supportedRules = descriptors.Select(d => d.Id).ToList(),
                partialAnalysis = false,
                sarif = true,
            },
            rules = descriptors.Select(d => new { id = d.Id, category = d.Category, paradigms = d.Paradigms.Order(StringComparer.Ordinal).ToList(), title = d.Title }).ToList(),
        };
        WriteStdout(JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true }).ReplaceLineEndings("\n"));
        return Success;
    }

    private static async Task<int> AnalyzeAsync(string[] args)
    {
        string? root = null, sarif = null, config = null, rules = null;
        for (var i = 0; i < args.Length; i += 2)
        {
            if (i + 1 >= args.Length) return Usage($"Missing value for {args[i]}");
            var value = args[i + 1];
            switch (args[i])
            {
                case "--root": root = value; break;
                case "--sarif": sarif = value; break;
                case "--config": config = value; break;
                case "--rules": rules = value; break;
                // Accepted by every analyzer in the protocol; this one analyzes the whole root (partialAnalysis = false).
                case "--files": break;
                default: return Usage($"Unknown option: {args[i]}");
            }
        }
        if (root is null) return Usage("--root is required");
        if (!Directory.Exists(root))
        {
            await Console.Error.WriteLineAsync($"error: root does not exist: {root}").ConfigureAwait(false);
            return BadInput;
        }

        var settings = config is null ? new NomosConfig() : WorkspaceFile.Load(config);
        var catalog = BuiltInComponents.Catalog();
        var selected = rules?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var unknown = selected?.FirstOrDefault(id => catalog.Analyzers.All(a => a.Descriptor.Id != id));
        if (unknown is not null) return Usage($"Unknown rule: {unknown}");
        var running = selected is null ? catalog : catalog.Filter(d => selected.Contains(d.Id, StringComparer.Ordinal));
        var result = await new AnalysisEngine(running).RunAsync(new AnalysisRequest { Path = root, Config = settings }).ConfigureAwait(false);
        if (result.Model is not { Files.Count: > 0 })
        {
            await Console.Error.WriteLineAsync($"error: no C# files under {root}").ConfigureAwait(false);
            return BadInput;
        }

        var options = new FactsOptions(Name, Version, [.. catalog.Analyzers.Select(a => a.Descriptor)])
        {
            SarifFile = sarif,
            ResultCount = result.Findings.Count,
            RuleTexts = SpecRules.Load(),
        };
        if (sarif is not null)
        {
            await using var stream = new StreamWriter(sarif, append: false, new UTF8Encoding(false));
            SarifProfileWriter.Write(result, options, stream);
        }

        WriteStdout(FactsWriter.Write(result, options));
        // Findings never change the exit code; only an incomplete result does (docs/ARCHITECTURE.md, exit code 4).
        return result.Model.Files.Any(f => f.HasSyntaxErrors) ? Partial : Success;
    }

    private static void WriteStdout(string text)
    {
        using var stdout = Console.OpenStandardOutput();
        stdout.Write(new UTF8Encoding(false).GetBytes(text + "\n"));
    }
}
