# frozen_string_literal: true

# Finding texts as templates of spec/rules with their arguments (spec/l10n.md).
module NomosRuby
  # The English template ({0}, {1}...) and its arguments; a client can show it in another language.
  Text = Struct.new(:template, :args)

  module Texts
    module_function

    # Builds a text from a literal template of spec/rules; the tests read these calls from the source.
    def tx(template, *args)
      Text.new(template, args.map { |a| argument(a) })
    end

    def argument(value)
      raise TypeError, "a boolean is not an argument of a finding text" if value == true || value == false
      raise TypeError, "argument #{value} is not an integer; format it with fixed()" if value.is_a?(Float)

      value.is_a?(Integer) ? value.to_s : value
    end

    # Math.round of JavaScript: half rounds up.
    def js_round(value)
      (value + 0.5).floor.to_f
    end

    # A number with a fixed count of decimals, culture-free and rounded half away from zero, as JavaScript does.
    def fixed(value, digits)
      scale = 10**digits
      rounded = js_round(value * scale) / scale
      format("%.#{digits}f", rounded)
    end

    def round_to(value, digits)
      scale = 10**digits
      js_round(value * scale) / scale
    end

    # Puts the arguments into the template; {{ and }} are braces.
    def render(text)
      t = text.template
      out = +""
      i = 0
      while i < t.length
        c = t[i]
        if "{}".include?(c) && i + 1 < t.length && t[i + 1] == c
          out << c
          i += 2
          next
        end
        if c == "{"
          finish = t.index("}", i)
          out << text.args[t[(i + 1)...finish].to_i]
          i = finish + 1
          next
        end
        out << c
        i += 1
      end
      out
    end
  end
end
