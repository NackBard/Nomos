# frozen_string_literal: true

require "json"
require "set"

# The protocol of docs/ARCHITECTURE.md: facts to stdout, SARIF to the file named by --sarif, messages to stderr.
module NomosRuby
  SUCCESS = 0
  UNEXPECTED = 1
  USAGE = 2
  BAD_INPUT = 3
  PARTIAL = 4
  OPTIONS = %w[--root --sarif --config --rules --files].freeze

  def self.usage(message)
    $stderr.write("#{message}\nUsage: nomos-ruby manifest | analyze --root <path> [--sarif <file>] [--config <nomos.json>] [--rules <ids>]\n")
    USAGE
  end

  def self.write(text)
    $stdout.binmode
    $stdout.write(text)
    $stdout.flush
  end

  def self.analyze_command(args)
    require_relative "facts"
    require_relative "project"
    values = {}
    (0...args.size).step(2) do |i|
      return usage("Missing value for #{args[i]}") if i + 1 >= args.size
      return usage("Unknown option: #{args[i]}") unless OPTIONS.include?(args[i])

      values[args[i]] = args[i + 1] # --files is ignored: the analyzer always reads the whole root (partialAnalysis = false)
    end
    root = values["--root"]
    return usage("--root is required") if root.nil? || root.empty?
    unless File.directory?(root)
      $stderr.write("error: root does not exist: #{root}\n")
      return BAD_INPUT
    end
    begin
      config = load_config(values["--config"])
    rescue ConfigError => e
      $stderr.write("error: #{e.message}\n")
      return BAD_INPUT
    end
    selected = nil
    if values["--rules"] && !values["--rules"].empty?
      selected = Set.new
      values["--rules"].split(",").each do |raw|
        rule = raw.strip
        return usage("Unknown rule: #{rule}") unless SUPPORTED.include?(rule)

        selected << rule
      end
    end
    include, exclude = config.scope
    project = Project.new(root)
    project.load(include, exclude)
    facts, partial = NomosRuby.analyze(project, values["--sarif"], selected, config, root)
    write(facts)
    partial ? PARTIAL : SUCCESS # findings never change the exit code, only an incomplete result does
  end

  def self.main(argv)
    if (RUBY_VERSION.split(".").map(&:to_i) <=> [3, 3]).negative?
      $stderr.write("error: Nomos needs Ruby 3.3 or newer\n")
      return BAD_INPUT
    end
    if argv == ["manifest"]
      require_relative "facts"
      write(json(manifest))
      return SUCCESS
    end
    return analyze_command(argv.drop(1)) if argv.first == "analyze"

    usage("Unknown command or option: #{argv.join(" ")}")
  rescue SystemStackError => e
    $stderr.write("error: the syntax tree is too deep\n#{e.full_message(highlight: false)}")
    UNEXPECTED
  rescue StandardError, ScriptError => e # an analyzer bug must not look like a finding: exit code 1 and the stack for the author
    $stderr.write("error: #{e.full_message(highlight: false)}")
    UNEXPECTED
  end
end
