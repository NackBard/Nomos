using System.Globalization;
using System.Text;

namespace Nomos.Abstractions;

/// <summary>
/// A text of a finding kept as a template with numbered placeholders and its arguments, so that a client can
/// show it in another language (spec/l10n.md). The template is the English text of spec/rules with <c>{0}</c>,
/// <c>{1}</c>…; format specifiers of the interpolation are applied to the arguments in the invariant culture.
/// </summary>
/// <param name="Template">English template, for example <c>{0} spans {1} lines</c>.</param>
/// <param name="Arguments">Formatted arguments.</param>
public sealed record TemplateText(string Template, IReadOnlyList<string> Arguments)
{
    /// <summary>Gets the text with the arguments in place.</summary>
    public string Text => Arguments.Count == 0 ? Template.Replace("{{", "{", StringComparison.Ordinal).Replace("}}", "}", StringComparison.Ordinal)
        : string.Format(CultureInfo.InvariantCulture, Template, [.. Arguments]);

    /// <summary>Splits an interpolated string into its template and invariant-culture arguments.</summary>
    /// <param name="text">The interpolated string.</param>
    /// <returns>The template text.</returns>
    public static TemplateText From(FormattableString text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var format = text.Format;
        var template = new StringBuilder(format.Length);
        var arguments = new List<string>();
        for (var i = 0; i < format.Length; i++)
        {
            var c = format[i];
            if ((c == '{' || c == '}') && i + 1 < format.Length && format[i + 1] == c)
            {
                template.Append(c).Append(c);
                i++;
                continue;
            }
            if (c != '{')
            {
                template.Append(c);
                continue;
            }
            var end = format.IndexOf('}', i);
            var hole = format[(i + 1)..end];
            var colon = hole.IndexOf(':', StringComparison.Ordinal);
            var specifier = colon < 0 ? null : hole[(colon + 1)..];
            var head = colon < 0 ? hole : hole[..colon];
            var comma = head.IndexOf(',', StringComparison.Ordinal);
            var index = int.Parse(comma < 0 ? head : head[..comma], CultureInfo.InvariantCulture);
            var value = text.GetArgument(index);
            template.Append('{').Append(arguments.Count.ToString(CultureInfo.InvariantCulture)).Append('}');
            arguments.Add(value switch
            {
                null => "",
                IFormattable formattable => formattable.ToString(specifier, CultureInfo.InvariantCulture),
                _ => value.ToString() ?? "",
            });
            i = end;
        }
        return new TemplateText(template.ToString(), arguments);
    }

    /// <inheritdoc />
    public bool Equals(TemplateText? other) => other is not null && Template == other.Template && Arguments.SequenceEqual(other.Arguments);

    /// <inheritdoc />
    public override int GetHashCode() => HashCode.Combine(Template, Arguments.Count);
}
