# frozen_string_literal: true

require "json"

# The workspace file (contracts/nomos.schema.json) and the rules and practices of spec.
module NomosRuby
  HERE = __dir__

  def self.spec_rules
    @spec_rules ||= JSON.parse(File.read(File.join(HERE, "rules.json"), encoding: "UTF-8"))
  end

  def self.spec_practices
    @spec_practices ||= JSON.parse(File.read(File.join(HERE, "practices.json"), encoding: "UTF-8"))
  end

  # The input is unusable: exit code 3.
  class ConfigError < StandardError; end

  # The part of nomos.json this analyzer reads.
  class Config
    attr_reader :language, :analyzers, :rules, :practices, :paradigms, :layers, :category_weights, :severity_penalties,
                :confidence_factors, :decay_per_kloc, :min_kloc

    def initialize(raw, language = "ruby")
      @language = language
      @analyzers = raw["analyzers"] || []
      @rules = raw["rules"] || {}
      @practices = raw["practices"]
      @paradigms = raw["paradigms"] || {}
      @layers = raw["layers"] || []
      scoring = raw["scoring"] || {}
      @category_weights = scoring["categoryWeights"] || {}
      @severity_penalties = { "info" => 0, "minor" => 1, "major" => 3, "critical" => 8 }.merge(scoring["severityPenalties"] || {})
      @confidence_factors = { "low" => 0.25, "medium" => 0.6, "high" => 1 }.merge(scoring["confidenceFactors"] || {})
      @decay_per_kloc = scoring["decayPerKloc"] || 20
      @min_kloc = scoring["minKloc"] || 0.2
    end

    # The include and exclude globs of this language.
    def scope
      own = @analyzers.find { |a| a["language"] == @language }
      own ? [own["include"] || [], own["exclude"] || []] : [[], []]
    end

    # D-011: the functional style is opt-in, as in the other analyzers.
    def enabled_paradigms
      (@paradigms[@language] || %w[oop structural]).to_a
    end

    # For each rule outside the selected practices, the message for skippedRules (D-051); nil selects all.
    def outside_practices
      return nil if @practices.nil?

      owners = {}
      NomosRuby.spec_practices.each do |practice|
        practice["rules"].each { |rule| (owners[rule] ||= []) << practice["id"] }
      end
      outside = {}
      owners.each do |rule, owned|
        next if owned.any? { |p| @practices.include?(p) }

        outside[rule] = "Rule belongs to practice #{owned.sort.join(" or ")}, which is not selected; 'practices' in nomos.json selects them"
      end
      outside
    end

    def threshold(rule, name)
      own = (@rules[rule["id"]] || {})["threshold"]
      return own[name] if own&.key?(name)

      (rule["threshold"] || {})[name]
    end

    def number(rule, name)
      value = threshold(rule, name)
      value.is_a?(Numeric) ? value : 0
    end

    def layer_of(module_id)
      @layers.each do |layer|
        (layer["patterns"] || []).each do |pattern|
          expression = pattern.split("*", -1).map { |part| Regexp.escape(part) }.join(".*")
          return layer if Regexp.new("\\A#{expression}\\z", Regexp::IGNORECASE).match?(module_id)
        end
      end
      nil
    end
  end

  # Reads the file named by --config; no path gives the defaults.
  def self.load_config(file, language = "ruby")
    return Config.new({}, language) if file.nil? || file.empty?

    begin
      text = File.read(file, mode: "rb").force_encoding("UTF-8").delete_prefix("﻿")
    rescue SystemCallError
      raise ConfigError, "config file not found: #{file}"
    end
    begin
      raw = JSON.parse(text)
    rescue JSON::ParserError => e
      raise ConfigError, "#{file}: #{e.message}"
    end
    version = raw.is_a?(Hash) ? raw["schemaVersion"] : nil
    raise ConfigError, "#{file}: expected schemaVersion 1.x, found '#{version}'" unless version.is_a?(String) && version.start_with?("1.")

    if raw["practices"] && !raw["practices"].empty?
      known = spec_practices.map { |p| p["id"] }
      raw["practices"].each { |p| raise ConfigError, "#{file}: unknown practice '#{p}'" unless known.include?(p) }
    end
    Config.new(raw, language)
  end
end
