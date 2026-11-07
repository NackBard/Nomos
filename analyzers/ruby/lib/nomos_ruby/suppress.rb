# frozen_string_literal: true

# The suppressions of one file (spec/suppressions.md).
module NomosRuby
  class Directives
    DIRECTIVE = /nomos-disable(-next-line|-line)?([ \t,\w.*]*)/.freeze

    attr_reader :file, :lines

    def initialize
      @file = []
      @lines = Hash.new { |h, k| h[k] = [] }
    end

    # Reads a comment spanning lines start to finish.
    def add(comment, start, finish)
      match = DIRECTIVE.match(comment)
      return unless match

      ids = match[2].split(/[ \t,]+/).reject(&:empty?)
      ids = ["*"] if ids.empty?
      case match[1]
      when "-line" then @lines[start].concat(ids)
      when "-next-line" then @lines[finish + 1].concat(ids)
      else @file.concat(ids)
      end
    end

    def covers?(rule, line)
      [@file, @lines.fetch(line, [])].any? { |ids| ids.any? { |i| i == "*" || i.downcase == rule.downcase } }
    end
  end
end
