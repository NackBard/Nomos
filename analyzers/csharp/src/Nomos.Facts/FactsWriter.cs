using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using Nomos.Abstractions;

namespace Nomos.Facts;

/// <summary>What the facts builder needs to know about the analyzer that calls it.</summary>
/// <param name="AnalyzerName">Analyzer name for <c>analyzer.name</c>.</param>
/// <param name="AnalyzerVersion">Analyzer build version.</param>
/// <param name="SupportedRules">Descriptors of every implemented rule, used to record skipped rules.</param>
public sealed record FactsOptions(string AnalyzerName, string AnalyzerVersion, IReadOnlyList<AnalyzerDescriptor> SupportedRules)
{
    /// <summary>Gets the SARIF file written for this run, as passed on the command line; <c>null</c> when none was requested.</summary>
    public string? SarifFile { get; init; }

    /// <summary>Gets the texts of the rules by spec id; SARIF rule descriptions come from here when present.</summary>
    public IReadOnlyDictionary<string, RuleText>? RuleTexts { get; init; }

    /// <summary>Gets the external inputs this run has, in the terms of <c>requires</c> in spec/rules.</summary>
    public IReadOnlySet<string> AvailableInputs { get; init; } = new HashSet<string>();

    /// <summary>Gets the number of results in that SARIF file.</summary>
    public int ResultCount { get; init; }
}

/// <summary>Texts of a rule from <c>spec/rules</c>.</summary>
/// <param name="Title">Short name of the rule.</param>
/// <param name="Description">What the detector looks at.</param>
/// <param name="Rationale">Why a reader may want to know.</param>
/// <param name="Requires">External inputs without which the rule cannot work.</param>
public sealed record RuleText(string Title, string Description, string Rationale, IReadOnlyList<string>? Requires = null);

/// <summary>Serializes an analysis result as a facts document (contracts/facts.schema.json).</summary>
public static class FactsWriter
{
    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>Builds facts from the IR kept in the result and returns them as JSON with LF line endings.</summary>
    /// <param name="result">Result of an analysis run; it must carry its <see cref="AnalysisResult.Model"/>.</param>
    /// <param name="options">Analyzer identity and rule descriptors.</param>
    public static string Write(AnalysisResult result, FactsOptions options)
    {
        var model = result.Model ?? throw new InvalidOperationException("The analysis result carries no project model.");
        return JsonSerializer.Serialize(new FactsBuilder(model, result, options).Build(), Options).ReplaceLineEndings("\n");
    }
}
