# frozen_string_literal: true

require "json"
require "set"
require_relative "config"
require_relative "coverage"
require_relative "estimate"
require_relative "graph"
require_relative "metrics"
require_relative "paradigms"
require_relative "rules"
require_relative "structure"

# The manifest, facts and SARIF of one run.
module NomosRuby
  NAME = "nomos-ruby"
  VERSION = "0.1.0"
  FACTS_VERSION = "1.3.0"
  MANIFEST_VERSION = "1.2.0"
  LANGUAGE = "ruby"

  def self.manifest
    by_id = spec_rules.to_h { |r| [r["id"], r] }
    {
      "name" => NAME,
      "language" => LANGUAGE,
      "version" => VERSION,
      "schemaVersion" => MANIFEST_VERSION,
      "paradigms" => %w[functional oop structural],
      "files" => ["**/*.rb"],
      "capabilities" => { "semantic" => false, "supportedRules" => SUPPORTED, "partialAnalysis" => false, "sarif" => true },
      "rules" => SUPPORTED.map { |i| { "id" => i, "category" => by_id[i]["category"], "paradigms" => by_id[i]["paradigms"].sort, "title" => by_id[i]["title"] } }
    }
  end

  def self.not_applicable(paradigm)
    {
      "oop" => "OOP rule not applicable: module has no classes",
      "functional" => "Functional rule not applicable: module shows no functional style",
      "structural" => "Structural rule not applicable: module has no free functions or branching"
    }.fetch(paradigm) { "Rule for paradigm '#{paradigm}' not applicable: no evidence of it in the module" }
  end

  def self.level(severity)
    return "error" if severity == "critical"

    severity == "info" ? "note" : "warning"
  end

  def self.score(config, loc, findings, categories)
    weight = ->(c) { config.category_weights.fetch(c, 1) }
    total_weight = categories.sum { |c| weight.call(c) }
    kloc = [loc / 1000.0, config.min_kloc].max
    total = 0.0
    result = categories.map do |category|
      own = findings.select { |f| f.category == category }
      penalty = own.sum(0.0) { |f| config.severity_penalties.fetch(f.severity, 0) * config.confidence_factors.fetch(f.confidence, 0) }
      value = 100 * Math.exp(-penalty / kloc / config.decay_per_kloc)
      share = total_weight.positive? ? weight.call(category).to_f / total_weight : 0
      total += value * share
      { "category" => category, "score" => Texts.round_to(value, 1), "weight" => Texts.round_to(share, 3), "penalty" => Texts.round_to(penalty, 2), "findingCount" => own.size }
    end
    { "score" => total, "categories" => result, "explanation" => ["Weighted mean over #{categories.size} categories, normalized by #{format("%.3f", kloc)} KLOC."] }
  end

  # Whole floats are written as integers, like JavaScript writes them.
  def self.clean(value)
    case value
    when Hash then value.transform_values { |v| clean(v) }
    when Array then value.map { |v| clean(v) }
    when Float then value.finite? && value == value.floor ? value.to_i : value
    else value
    end
  end

  def self.json(document)
    # Empty arrays and objects as [] and {}: json 2.7 (Ruby 3.3) breaks them over lines, newer versions do not. A
    # string in JSON never holds a raw line break, so the pattern meets only the structure.
    JSON.pretty_generate(clean(document)).gsub(/\[\n\s*\n\s*\]/, "[]").gsub(/\{\n\s*\n\s*\}/, "{}") + "\n"
  end

  def self.analyze(p, sarif_file, selected, config, root)
    edges = collect_edges(p)
    graphs = build_graphs(p, edges)
    estimates = Estimates.time_estimates(p)
    run = Run.new(p, config, edges, graphs, estimates)
    pure = Paradigms.pure_functions(p)
    enabled = config.enabled_paradigms
    report = (((config.rules["MNT004"] || {})["threshold"]) || {})["report"]
    if report.is_a?(String) && !report.empty?
      begin
        run.coverage = Coverage.load(File.join(root, report))
      rescue SystemCallError
        run.coverage = nil
      end
    end
    modules = p.modules
    evidence = {}
    shown = {}
    modules.each do |ns|
      evidence[ns.id] = Paradigms.collect_evidence(p, ns, pure)
      shown[ns.id] = Paradigms.active(evidence[ns.id])
      run.active[ns.id] = shown[ns.id].select { |x| enabled.include?(x) }
    end

    rules = spec_rules
    supported = SUPPORTED.to_set
    outside = config.outside_practices
    skips = []
    categories = Set.new
    inputs = { "layer-config" => !config.layers.empty?, "coverage-report" => !run.coverage.nil? }
    rules.each do |rule|
      rid = rule["id"]
      unless supported.include?(rid)
        unless rid.include?(".")
          message = case rid
                    when "STR001" then "Ruby has no goto"
                    when "OOP001" then "Ruby has no public fields: instance variables are reached only through methods"
                    else "Rule is not implemented for Ruby"
                    end
          skips << { "ruleId" => rid, "reason" => "not-supported", "message" => message }
        end
        next
      end
      explicit = (config.rules[rid] || {})["enabled"]
      by_config = explicit == false || (selected && !selected.include?(rid))
      practice_message = outside && explicit.nil? ? outside[rid] : nil
      any_enabled = rule["paradigms"].empty? || rule["paradigms"].any? { |x| enabled.include?(x) }
      if !any_enabled
        skips << { "ruleId" => rid, "reason" => "disabled-by-config",
                   "message" => "Rule needs paradigm #{rule["paradigms"].sort.join(" or ")}, which is off for this language; 'paradigms' in nomos.json selects them" }
      elsif by_config
        skips << { "ruleId" => rid, "reason" => "disabled-by-config", "message" => "Rule is off by nomos.json or by --rules" }
      elsif practice_message
        skips << { "ruleId" => rid, "reason" => "disabled-by-config", "message" => practice_message }
      end
      next if by_config || practice_message || !any_enabled

      run.rule = rule
      run.ran[rid] = rule
      categories << rule["category"]
      DETECTORS[rid].call(run)
      (rule["requires"] || []).each do |needed|
        skips << { "ruleId" => rid, "reason" => "missing-input", "message" => "Rule not applied: no #{needed} in the configuration" } unless inputs[needed]
      end
    end
    rules.each do |rule|
      next unless supported.include?(rule["id"]) && !rule["paradigms"].empty?

      ran = run.ran.key?(rule["id"])
      modules.each do |ns|
        own = shown[ns.id]
        applies = rule["paradigms"].any? { |x| own.include?(x) }
        active = rule["paradigms"].any? { |x| own.include?(x) && enabled.include?(x) }
        if !applies
          skips << { "ruleId" => rule["id"], "module" => ns.id, "reason" => "paradigm-not-detected", "message" => not_applicable(rule["paradigms"][0]) }
        elsif ran && !active
          skips << { "ruleId" => rule["id"], "module" => ns.id, "reason" => "disabled-by-config",
                     "message" => "Rule not applied: every paradigm the module shows for it is off for this language" }
        end
      end
    end
    skips.sort_by! { |s| [s["ruleId"], s.fetch("module", ""), s["reason"]] }

    by_file = p.files.to_h { |f| [f.path, f] }
    ordered = sort_findings(run.findings)
    findings = ordered.reject { |f| (file = by_file[f.place.file]) && file.directives.covers?(f.rule, f.place.start_line) }
    suppressed = ordered.size - findings.size
    findings.each { |f| f.module = by_file[f.place.file].module.id if (f.module.nil? || f.module.empty?) && by_file[f.place.file] }
    category_list = categories.to_a.sort

    diagnostics = p.notes.dup
    partial = false
    files = p.files.map do |f|
      entry = { "path" => f.path, "lines" => f.lines, "loc" => f.loc }
      if run.coverage
        percent = run.coverage.percent(f.path)
        entry["coverage"] = percent if percent
      end
      entry["module"] = f.module.id
      entry["parsed"] = !f.broken
      if f.broken
        partial = true
        diagnostics << { "level" => "warning", "message" => "Syntax errors: declarations in this file are missing from the facts.", "file" => f.path, "code" => "syntax-error" }
      end
      entry
    end
    diagnostics << { "level" => "info", "message" => "#{suppressed} finding(s) suppressed by directives.", "code" => "suppressed" } if suppressed.positive?
    diagnostics << { "level" => "info", "message" => "No Ruby files under the root outside dependency and build folders.", "code" => "no-files" } if p.files.empty?

    total = 0.0
    total_loc = 0
    module_entries = modules.map do |ns|
      loc = ns.files.sum(&:loc)
      own = findings.select { |f| f.module == ns.id }
      health = score(config, loc, own, category_list)
      total += health["score"] * loc
      total_loc += loc
      { "id" => ns.id, "name" => ns.name, "files" => ns.files.map(&:path), "loc" => loc, "metrics" => run.martin(ns),
        "paradigmEvidence" => evidence[ns.id], "activeParadigms" => shown[ns.id], "health" => health.merge("score" => Texts.round_to(health["score"], 1)) }
    end
    project_score = total_loc.positive? ? total / total_loc : 100
    project_categories = category_list.map { |c| score(config, [total_loc, 1].max, findings.select { |f| f.category == c }, [c])["categories"][0] }

    types = p.all_types.map do |t|
      metrics = { "lines" => Metrics.line_span(t.place), "memberCount" => member_count(t),
                  "methodCount" => t.methods.count { |m| %w[method constructor].include?(m.kind) }, "blastRadius" => graphs.radius.fetch(t.id, 0) }
      if t.kind == "class"
        metrics.merge!("dit" => Metrics.dit(p, t), "cbo" => run.cbo(t), "lcom4" => Metrics.lcom4(p, t), "wmc" => Metrics.wmc(t),
                       "atfd" => Metrics.atfd(p, t), "tcc" => Metrics.tcc(p, t))
      end
      entry = { "id" => t.id, "name" => t.name, "module" => t.namespace.id, "kind" => t.kind, "isAbstract" => t.is_abstract, "location" => t.place.to_h }
      own_members = Structure.members(p, t)
      entry["members"] = own_members if own_members
      entry["metrics"] = metrics
      entry
    end

    functions = p.all_functions.map do |f|
      unit = f.owner ? f.owner.id : f.id
      metrics = {
        "cyclomatic" => Metrics.cyclomatic(f), "maxNesting" => Metrics.max_nesting(f), "parameterCount" => Metrics.parameter_count(f),
        "lines" => Metrics.line_span(f.place), "hofOrder" => Metrics.hof_order(p, f), "lambdaNesting" => Metrics.lambda_nesting(f),
        "typeTests" => Metrics.tested_types(p, f).size, "blastRadius" => graphs.radius.fetch(unit, 0),
        "timeDegree" => nil, "timeLogFactor" => nil, "timeExponential" => nil, "spaceDegree" => nil, "allocationDepth" => nil,
        "foreignMembers" => nil, "ownMembers" => nil, "halsteadVolume" => nil, "maintainabilityIndex" => nil
      }
      volume = Metrics.halstead_volume(f)
      if volume
        metrics["halsteadVolume"] = Texts.round_to(volume, 4)
        metrics["maintainabilityIndex"] = Texts.round_to(Metrics.maintainability_index(f), 4)
      end
      growth = estimates[f.id]
      if growth
        metrics["timeExponential"] = growth.exponential ? 1 : 0
        unless growth.exponential
          metrics["timeDegree"] = growth.degree
          metrics["timeLogFactor"] = growth.log
        end
        metrics["spaceDegree"] = Metrics.space_degree(p, f, Estimates.self_calls(p, f).size)
        metrics["allocationDepth"] = Metrics.allocation_depth(p, f)
      end
      if Metrics.instance_method?(f)
        metrics["foreignMembers"] = Metrics.most_used_foreign(p, f)[1].size
        metrics["ownMembers"] = Metrics.member_use(p, f)[0].size
      end
      entry = { "id" => f.id, "name" => f.name, "module" => f.namespace.id }
      entry["type"] = f.owner.id if f.owner
      entry["kind"] = f.kind
      entry["visibility"] = f.visibility
      entry["location"] = f.place.to_h
      entry["parameters"] = Structure.parameters(f)
      result = Structure.return_type_name(f)
      entry["returnTypeName"] = result if result
      entry["isStatic"] = true if f.is_static
      entry["isAbstract"] = true if f.is_abstract
      entry["metrics"] = metrics
      entry
    end

    merged = {}
    edges.each do |e|
      phase = e.type_only ? "type-only" : "runtime"
      key = [e.source, e.to, e.kind, phase]
      if merged.key?(key)
        merged[key]["count"] += 1
      else
        merged[key] = { "from" => e.source, "to" => e.to, "kind" => e.kind, "phase" => phase, "external" => e.external, "stdlib" => e.stdlib,
                        "count" => 1, "location" => e.place.to_h }
      end
    end
    dependencies = merged.keys.sort_by { |k| k.join("\0") }.map { |k| merged[k] }
    cycles = components(graphs.runtime_units).map { |c| { "level" => "type", "members" => c } } +
             components(graphs.runtime_modules).map { |c| { "level" => "module", "members" => c } }

    document = {
      "schemaVersion" => FACTS_VERSION,
      "analyzer" => { "name" => NAME, "version" => VERSION, "language" => LANGUAGE, "semantic" => false },
      "files" => files, "modules" => module_entries, "types" => types, "functions" => functions, "dependencies" => dependencies, "cycles" => cycles,
      "health" => { "score" => Texts.round_to(project_score, 1), "categories" => project_categories,
                    "explanation" => ["Mean of #{module_entries.size} module score(s), weighted by lines of code (#{total_loc} total)."] },
      "skippedRules" => skips,
      "diagnostics" => diagnostics
    }
    if sarif_file
      File.binwrite(sarif_file, sarif(findings))
      document["checks"] = { "sarifFile" => sarif_file, "resultCount" => findings.size }
    end
    [json(document), partial]
  end

  def self.key_of(rule, template)
    ((rule || {})["messages"] || {}).select { |_, m| m["text"] == template }.keys.min
  end

  def self.sarif(findings)
    by_id = spec_rules.to_h { |r| [r["id"], r] }
    ids = SUPPORTED.sort
    index = ids.each_with_index.to_h
    rules = ids.map do |rid|
      rule = by_id[rid]
      entry = { "id" => rid, "name" => rule["title"], "shortDescription" => { "text" => rule["description"] }, "fullDescription" => { "text" => rule["rationale"] },
                "defaultConfiguration" => { "level" => level(rule["severity"]) }, "properties" => { "category" => rule["category"], "paradigms" => rule["paradigms"].sort } }
      entry["messageStrings"] = rule["messages"].keys.sort.to_h { |k| [k, { "text" => rule["messages"][k]["text"] }] } if rule["messages"] && !rule["messages"].empty?
      entry
    end
    results = findings.map do |f|
      rule = by_id[f.rule]
      properties = { "severity" => f.severity, "confidence" => f.confidence, "explanation" => f.explanation }
      properties["module"] = f.module if f.module && !f.module.empty?
      properties["entity"] = f.entity if f.entity && !f.entity.empty?
      properties["measured"] = f.measured if f.measured
      explanation_key = key_of(rule, f.explanation_text.template)
      properties["explanationMessage"] = { "id" => explanation_key, "arguments" => f.explanation_text.args } if explanation_key
      message = { "text" => f.message }
      message_key = key_of(rule, f.message_text.template)
      if message_key
        message["id"] = message_key
        message["arguments"] = f.message_text.args
      end
      place = f.place
      { "ruleId" => f.rule, "ruleIndex" => index[f.rule], "level" => level(f.severity), "message" => message,
        "locations" => [{ "physicalLocation" => { "artifactLocation" => { "uri" => place.file },
                                                  "region" => { "startLine" => place.start_line, "startColumn" => place.start_column, "endLine" => place.end_line, "endColumn" => place.end_column } } }],
        "partialFingerprints" => { "nomos/v1" => fingerprint(f) },
        "properties" => properties }
    end
    document = { "$schema" => "https://json.schemastore.org/sarif-2.1.0.json", "version" => "2.1.0",
                 "runs" => [{ "tool" => { "driver" => { "name" => NAME, "version" => VERSION, "semanticVersion" => VERSION, "rules" => rules } }, "results" => results }] }
    json(document)
  end
end
