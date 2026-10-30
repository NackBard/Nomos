using System.Globalization;
using System.Net;
using Nomos.Abstractions;

namespace Nomos.Reporting;

/// <summary>Writes a self-contained HTML page.</summary>
public sealed class HtmlReportWriter : IReportWriter
{
    private const string Style = """
        :root { --bg:#fff; --fg:#1f2328; --muted:#59636e; --line:#d1d9e0; --card:#f6f8fa; --bad:#cf222e; --warn:#9a6700; --ok:#1a7f37; }
        @media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --line:#30363d; --card:#151b23; --bad:#ff7b72; --warn:#d29922; --ok:#3fb950; } }
        body { background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,sans-serif; max-width:1000px; margin:0 auto; padding:24px 16px; }
        h1 { font-size:24px; } h2 { font-size:18px; margin-top:32px; border-bottom:1px solid var(--line); padding-bottom:4px; }
        .score { font-size:44px; font-weight:700; } .muted { color:var(--muted); }
        table { border-collapse:collapse; width:100%; } th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); }
        td.n,th.n { text-align:right; font-variant-numeric:tabular-nums; }
        details { border:1px solid var(--line); border-radius:6px; padding:8px 12px; margin:8px 0; background:var(--card); }
        summary { cursor:pointer; } pre { overflow-x:auto; background:var(--bg); padding:8px; border-radius:6px; }
        .Critical,.Major { color:var(--bad); } .Minor { color:var(--warn); } .Info { color:var(--ok); }
        """;

    /// <inheritdoc />
    public string Format => "html";

    /// <inheritdoc />
    public string FileExtension => ".html";

    /// <inheritdoc />
    public void Write(AnalysisResult result, TextWriter output)
    {
        var inv = CultureInfo.InvariantCulture;
        output.WriteLine($"<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Nomos: {E(result.ProjectName)}</title><style>{Style}</style></head><body>");
        output.WriteLine($"<h1>Nomos report: {E(result.ProjectName)}</h1>");
        output.WriteLine(string.Create(inv, $"<p><span class=\"score\">{result.Health.Score:0.0}</span></p>"));
        output.WriteLine($"<p class=\"muted\">{result.FileCount} files, {result.Findings.Count} findings, {result.Suppressed.Count} suppressed. Every finding is a heuristic result; confidence states how likely it is to be right.</p>");
        output.WriteLine("<ul>");
        foreach (var line in result.Health.Explanation) output.WriteLine($"<li>{E(line)}</li>");
        output.WriteLine("</ul><h2>Categories</h2><table><tr><th>Category</th><th class=\"n\">Score</th><th class=\"n\">Weight</th><th class=\"n\">Findings</th></tr>");
        foreach (var c in result.Health.Categories)
            output.WriteLine(string.Create(inv, $"<tr><td>{E(c.Category)}</td><td class=\"n\">{c.Score:0.0}</td><td class=\"n\">{c.Weight:0.###}</td><td class=\"n\">{c.FindingCount}</td></tr>"));
        output.WriteLine("</table><h2>Modules</h2><table><tr><th>Module</th><th class=\"n\">Score</th><th class=\"n\">Lines</th></tr>");
        foreach (var m in result.Modules.OrderBy(m => m.Health.Score).ThenBy(m => m.Module, StringComparer.Ordinal))
            output.WriteLine(string.Create(inv, $"<tr><td>{E(m.Module)}</td><td class=\"n\">{m.Health.Score:0.0}</td><td class=\"n\">{m.LinesOfCode}</td></tr>"));
        output.WriteLine("</table><h2>Findings</h2>");
        foreach (var f in result.Findings.OrderByDescending(f => f.Severity).ThenByDescending(f => f.Confidence))
        {
            output.WriteLine($"<details><summary><strong class=\"{f.Severity}\">{f.Severity}</strong> {E(f.AnalyzerId)}: {E(f.Message)} <span class=\"muted\">({f.Confidence} confidence)</span></summary>");
            output.WriteLine($"<p class=\"muted\">{E(f.Evidence.Location.FilePath)}:{f.Evidence.Location.StartLine}</p><p>{E(f.Evidence.Explanation)}</p><pre><code>{E(f.Evidence.Snippet)}</code></pre></details>");
        }
        output.WriteLine("</body></html>");
    }

    private static string E(string? text) => WebUtility.HtmlEncode(text ?? string.Empty);
}
