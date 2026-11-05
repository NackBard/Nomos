package analyzer

import (
	"fmt"
	"strconv"
	"strings"
)

// Text is a finding text kept as a template of spec/rules with numbered placeholders and its arguments, so that a
// client can show it in another language (spec/l10n.md). The template is the English text: {0}, {1}…
type Text struct {
	Template string
	Args     []string
}

// tx turns a printf format into a template: every verb becomes the next placeholder and its argument is formatted
// by that verb. The format must be a literal: TestTemplates reads the calls from the source and checks them in spec.
func tx(format string, args ...any) Text {
	var template strings.Builder
	formatted := []string{}
	next := 0
	for i := 0; i < len(format); i++ {
		c := format[i]
		switch {
		case c == '{' || c == '}':
			template.WriteByte(c)
			template.WriteByte(c)
		case c != '%':
			template.WriteByte(c)
		case i+1 < len(format) && format[i+1] == '%':
			template.WriteByte('%')
			i++
		default:
			end := i + 1
			for end < len(format) && strings.IndexByte("+-# 0123456789.", format[end]) >= 0 {
				end++
			}
			verb := format[i : end+1]
			template.WriteString("{" + strconv.Itoa(len(formatted)) + "}")
			formatted = append(formatted, fmt.Sprintf(verb, args[next]))
			next++
			i = end
		}
	}
	return Text{template.String(), formatted}
}

// String puts the arguments into the template.
func (t Text) String() string {
	var out strings.Builder
	for i := 0; i < len(t.Template); i++ {
		c := t.Template[i]
		if (c == '{' || c == '}') && i+1 < len(t.Template) && t.Template[i+1] == c {
			out.WriteByte(c)
			i++
			continue
		}
		if c == '{' {
			end := strings.IndexByte(t.Template[i:], '}') + i
			index, _ := strconv.Atoi(t.Template[i+1 : end])
			out.WriteString(t.Args[index])
			i = end
			continue
		}
		out.WriteByte(c)
	}
	return out.String()
}

// templateOf is the template tx makes of a format, for checking formats read from the source.
func templateOf(format string) string {
	count := strings.Count(format, "%") - 2*strings.Count(format, "%%")
	args := make([]any, count)
	for i := range args {
		args[i] = 0
	}
	return tx(format, args...).Template
}
