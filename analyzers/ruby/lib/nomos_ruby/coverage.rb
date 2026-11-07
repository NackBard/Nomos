# frozen_string_literal: true

require_relative "text"

# Line coverage from a Cobertura or LCOV report (spec/metrics.md).
module NomosRuby
  class Coverage
    attr_reader :files

    def initialize
      @files = {}
    end

    # Reads a report; the extension .xml means Cobertura.
    def self.load(file)
      text = File.read(file, mode: "rb").force_encoding("UTF-8").scrub.delete_prefix("﻿")
      c = Coverage.new
      if file.downcase.end_with?(".xml")
        text.scan(/<class\b[^>]*\bfilename="([^"]*)"[^>]*>([\s\S]*?)<\/class>/) do |name, body|
          lines = (c.files[name] ||= {})
          body.scan(/<line\b[^>]*>/) do |line|
            number = line[/\bnumber="(\d+)"/, 1]
            hits = line[/\bhits="(\d+)"/, 1]
            next unless number && hits

            n = number.to_i
            lines[n] = [lines.fetch(n, 0), hits.to_i].max
          end
        end
        return c
      end
      current = nil
      text.split(/\r?\n/).each do |raw|
        line = raw.strip
        if line.start_with?("SF:")
          current = {}
          c.files[line[3..]] = current
        elsif line.start_with?("DA:") && current
          parts = line[3..].split(",")
          current[parts[0].to_i] = parts[1].to_i if parts.length >= 2
        end
      end
      c
    end

    # The covered share of a file, nil when the report does not mention it.
    def percent(file)
      own = file.downcase
      @files.keys.sort.each do |name|
        reported = name.tr("\\", "/").downcase
        next unless reported == own || reported.end_with?("/#{own}")

        lines = @files[name]
        return 100 if lines.empty?

        covered = lines.values.count(&:positive?)
        return Texts.js_round(100.0 * covered / lines.size * 10_000) / 10_000
      end
      nil
    end
  end
end
