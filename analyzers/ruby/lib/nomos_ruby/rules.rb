# frozen_string_literal: true

require "digest"
require "set"
require_relative "estimate"
require_relative "graph"
require_relative "metrics"
require_relative "paradigms"
require_relative "text"

# The detectors. Every finding text is a template of its rule in spec/rules (checked by test/test_text.rb).
module NomosRuby
  Finding = Struct.new(:rule, :severity, :confidence, :category, :place, :message, :explanation, :module, :entity,
                       :message_text, :explanation_text, :measured)

  # The rules implemented for Ruby (D-061). STR001: no goto; OOP001: instance variables are never public.
  SUPPORTED = %w[
    ALG001 ALG002 ALG003 ALG004 CC001 CC002 CC003 CC004 CC009 DSN001 DSN002 DSN003 DSN004 DSN005 DSN006 FUN005 MNT001
    MNT002 MNT003 MNT004 OOP002 OOP003 OOP004 OOP005 PRN007 SEC001 SEC003 STR002 STR003
  ].freeze

  def self.fingerprint(f)
    Digest::SHA256.hexdigest("#{f.rule}|#{f.place.file}|#{f.entity}|#{f.message}")[0, 16]
  end

  def self.member_count(t)
    t.members.size + t.methods.count { |m| m.kind != "accessor" } + t.nested.size
  end

  # State of one analysis shared by the detectors.
  class Run
    include Texts

    attr_accessor :p, :config, :edges, :graphs, :estimates, :findings, :rule, :ran, :active, :coverage

    def initialize(p, config, edges, graphs, estimates)
      @p = p
      @config = config
      @edges = edges
      @graphs = graphs
      @estimates = estimates
      @findings = []
      @rule = nil
      @ran = {}
      @active = {}
      @coverage = nil
    end

    def applies?(ns)
      paradigms = @rule["paradigms"]
      paradigms.empty? || paradigms.any? { |x| @active.fetch(ns.id, []).include?(x) }
    end

    def number(name)
      @config.number(@rule, name)
    end

    def report(confidence, place, module_id, entity, message, explanation, measured = nil, severity = nil)
      level = (@config.rules[@rule["id"]] || {})["severity"] || severity || @rule["severity"]
      @findings << Finding.new(@rule["id"], level, confidence, @rule["category"], place, render(message), render(explanation),
                               module_id, entity, message, explanation, measured)
    end

    def functions
      @p.modules.select { |ns| applies?(ns) }.flat_map { |ns| Paradigms.module_functions(ns) }
    end

    def types
      @p.modules.select { |ns| applies?(ns) }.flat_map(&:types)
    end

    def martin(ns)
      inside = (ns.types.map(&:id) + ns.functions.map(&:id)).to_set
      incoming = Set.new
      outgoing = Set.new
      inside.each do |unit|
        @graphs.units.pred.fetch(unit, []).each { |o| incoming << o unless inside.include?(o) }
        @graphs.units.succ.fetch(unit, []).each { |o| outgoing << o unless inside.include?(o) }
      end
      ca = incoming.size
      ce = outgoing.size
      instability = ca + ce > 0 ? round_to(ce.to_f / (ca + ce), 4) : nil
      abstractness = ns.types.empty? ? nil : round_to(ns.types.count(&:is_abstract).to_f / ns.types.size, 4)
      distance = instability && abstractness ? round_to((abstractness + instability - 1).abs, 4) : nil
      { "ca" => ca, "ce" => ce, "instability" => instability, "abstractness" => abstractness, "distance" => distance }
    end

    def cbo(t)
      @by_source ||= @edges.group_by(&:source)
      @by_source.fetch(t.id, []).select { |e| e.kind != "import" && e.to_type && !e.stdlib }.map(&:to).uniq.size
    end

    def place(f, node)
      @p.place(f.file, node)
    end

    def value_kind(f, node)
      @p.resolver.value_of(node, @p.resolver.scope_of(f))&.builtin
    end
  end

  module Detectors
    extend Texts

    module_function

    def file_place(path)
      Place.new(path, 1, 1, 1, 1)
    end

    def module_place(ns)
      return file_place(ns.files.first.path) unless ns.files.empty?

      (ns.types.first || ns.functions.first).place
    end

    def cc001(r)
      limit = r.number("maxLines")
      r.functions.each do |f|
        lines = Metrics.line_span(f.place)
        next if !f.has_body || lines <= limit

        r.report("high", f.place, f.namespace.id, f.id, tx("{0} spans {1} lines", f.name, lines),
                 tx("The line count is exact; the limit of {0} is a readability convention.", limit),
                 { "metric" => "lines", "value" => lines, "threshold" => limit }, lines > limit * 2 ? "major" : nil)
      end
    end

    def cc002(r)
      max_lines = r.number("maxLines")
      max_members = r.number("maxMembers")
      r.types.each do |t|
        lines = Metrics.line_span(t.place)
        count = NomosRuby.member_count(t)
        next if lines <= max_lines && count <= max_members

        measured = lines > max_lines ? { "metric" => "lines", "value" => lines, "threshold" => max_lines } : nil
        r.report("high", t.place, t.namespace.id, t.id, tx("{0} has {1} lines and {2} members", t.name, lines, count),
                 tx("The counts are exact; the limits ({0} lines, {1} members) are conventions.", max_lines, max_members), measured)
      end
    end

    def cc003(r)
      limit = r.number("maxParameters")
      constructors = r.number("maxConstructorParameters")
      r.functions.each do |f|
        count = Metrics.parameter_count(f)
        own = f.kind == "constructor" ? constructors : limit
        next unless count > own

        r.report("high", f.place, f.namespace.id, f.id, tx("{0} takes {1} parameters", f.name, count),
                 tx("The limit is {0}. Long lists are easy to misorder; a parameter object groups what belongs together.", own),
                 { "metric" => "parameterCount", "value" => count, "threshold" => own })
      end
    end

    def cc004(r)
      limit = r.number("maxDepth")
      r.functions.each do |f|
        depth = Metrics.max_nesting(f)
        next unless depth > limit

        r.report("high", f.place, f.namespace.id, f.id, tx("{0} nests {1} levels deep", f.name, depth),
                 tx("The limit is {0}. Guard clauses or extracted functions flatten the flow.", limit),
                 { "metric" => "maxNesting", "value" => depth, "threshold" => limit })
      end
    end

    def empty_handler?(n)
      statements = Compat.statements(n.statements)
      statements.empty? || (statements.size == 1 && statements.first.type == :nil_node)
    end

    def cc009(r)
      r.functions.each do |f|
        file = f.file
        Metrics.walk_body(f) do |n|
          next unless n.type == :rescue_node && empty_handler?(n)

          # A comment in the handler, up to the next keyword, says why ignoring is safe.
          start = n.location.start_line
          following = file.tokens.find { |t| t.line > n.location.end_line || (t.line == n.location.end_line && false) }
          finish = following ? following.line - 1 : n.location.end_line
          finish = [finish, start].max
          next if file.comment_lines.any? { |line| line.between?(start, finish) }

          r.report("high", r.place(f, n), f.namespace.id, f.id, tx("Empty catch in {0}", f.name),
                   tx("The exception disappears without handling, logging or a comment saying why that is safe."))
        end
      end
    end

    def alg001(r)
      report_from = r.number("reportFromDegree")
      r.functions.each do |f|
        growth = r.estimates[f.id]
        next if growth.nil? || (!growth.exponential && growth.degree < report_from)

        explanation = if growth.uncertain
                        tx("Estimated from recursion, a while loop or a callee; loop bounds and call counts are not known exactly.")
                      else
                        tx("Estimated from nested loops over inputs of unknown size. Small inputs may make this irrelevant.")
                      end
        measured = if growth.exponential
                     { "metric" => "timeExponential", "value" => 1, "threshold" => 1 }
                   else
                     { "metric" => "timeDegree", "value" => growth.degree, "threshold" => report_from }
                   end
        r.report(growth.uncertain ? "low" : "medium", f.place, f.namespace.id, f.id, tx("{0} is likely {1}", f.name, Estimates.text(growth)),
                 explanation, measured, growth.exponential ? "major" : nil)
      end
    end

    SEARCHES = %i[include? index find_index].to_set.freeze

    def alg002(r)
      r.functions.each do |f|
        found = []
        Metrics.walk_loops(f) do |n, depth|
          next if depth.zero?

          if n.type == :call_node && n.receiver && n.receiver.type != :array_node && r.value_kind(f, n.receiver) == "array"
            found << [n, "search", n.name.to_s] if SEARCHES.include?(n.name)
            first = Compat.arguments(n).first
            found << [n, "front", n.name.to_s] if n.name == :unshift || n.name == :prepend || (n.name == :insert && Estimates.two?(first, 0))
          end
          if n.type == :local_variable_operator_write_node && Compat.operator(n) == "+" &&
             r.p.resolver.scope_of(f).values[n.name.to_s]&.builtin == "string"
            found << [n, "concat", ""]
          end
        end
        found.each do |n, kind, method|
          place = r.place(f, n)
          case kind
          when "search"
            r.report("medium", place, f.namespace.id, f.id, tx("Likely quadratic: {0} on a sequence inside a loop", method),
                     tx("Each iteration scans the list. A set or dict built once makes the lookup constant-time."))
          when "front"
            r.report("medium", place, f.namespace.id, f.id, tx("Likely quadratic: front insertion inside a loop"),
                     tx("Every element shifts on each call. Appending and reversing once avoids this."))
          else
            r.report("medium", place, f.namespace.id, f.id, tx("Likely quadratic: String concatenation inside a loop"),
                     tx("Each step copies the whole string so far. Collecting the parts in a list and joining once avoids this."))
          end
        end
      end
    end

    MATERIALIZING = %i[to_a to_h to_set dup clone sort].to_set.freeze

    def within?(node, outer)
      node.equal?(outer) || (outer.location.start_offset <= node.location.start_offset && node.location.end_offset <= outer.location.end_offset)
    end

    def alg003(r)
      limit = r.number("minDepthForObjects")
      r.functions.each do |f|
        measured = { "metric" => "allocationDepth", "value" => 0, "threshold" => limit }
        items = []
        Metrics.walk_loops(f) do |n, depth|
          items << [n, depth]
          measured["value"] = [measured["value"], depth].max if Metrics.allocates(r.p, f, n)
        end
        scope = r.p.resolver.scope_of(f)
        reported = []
        items.each do |n, depth|
          if depth >= 1 && n.type == :call_node && n.receiver && MATERIALIZING.include?(n.name) && Compat.arguments(n).empty? &&
             !Compat.block(n) && !r.p.resolver.call_target(n, scope).is_a?(FnRef)
            r.report("medium", r.place(f, n), f.namespace.id, f.id, tx("{0} allocates on each loop iteration", n.name.to_s),
                     tx("A new collection is built per iteration; moving it out of the loop or reusing a buffer reduces GC pressure."))
          end
          next if depth < limit || !Metrics.allocates(r.p, f, n) || reported.any? { |outer| within?(n, outer) }

          reported << n
          place = r.place(f, n)
          if Metrics.lambda?(n)
            r.report("low", place, f.namespace.id, f.id, tx("Lambda in a nested loop"), tx("Every evaluation of a lambda creates a new function object."), measured.dup)
          elsif n.type == :call_node
            r.report("low", place, f.namespace.id, f.id, tx("Allocation of {0} in a nested loop", Metrics.class_instantiation(r.p, f, n)),
                     tx("Runs once per inner iteration. Whether it matters depends on how hot the loop really is, which static analysis cannot tell."), measured.dup)
          else
            r.report("low", place, f.namespace.id, f.id, tx("Allocation in a nested loop"),
                     tx("Runs once per inner iteration. Whether it matters depends on how hot the loop really is, which static analysis cannot tell."), measured.dup)
          end
        end
      end
    end

    def alg004(r)
      report_from = r.number("reportFromDegree")
      r.functions.each do |f|
        next unless f.has_body

        degree = Metrics.space_degree(r.p, f, Estimates.self_calls(r.p, f).size)
        next unless degree >= report_from

        r.report("low", f.place, f.namespace.id, f.id, tx("{0} likely uses {1} extra memory", f.name, Estimates.text(Growth.new(degree, 0, false, false))),
                 tx("Estimated from collection growth under nested loops or multi-dimensional allocation sizes."),
                 { "metric" => "spaceDegree", "value" => degree, "threshold" => report_from })
      end
    end

    def dsn001(r)
      limit = r.number("maxDistance")
      coupling = r.number("minCoupling")
      r.p.modules.each do |ns|
        x = r.martin(ns)
        next if x["distance"].nil? || x["distance"] <= limit || x["ca"] + x["ce"] < coupling || ns.types.empty?

        a = fixed(x["abstractness"], 2)
        i = fixed(x["instability"], 2)
        explanation = if x["instability"] < 0.5
                        tx("A = {0}, I = {1}, so it sits near the zone of pain: concrete and heavily depended upon.", a, i)
                      else
                        tx("A = {0}, I = {1}, so it sits near the zone of uselessness: abstract and unused.", a, i)
                      end
        r.report("medium", ns.types.first.place, ns.id, "", tx("Module {0} is far from the main sequence (D = {1})", ns.id, fixed(x["distance"], 2)),
                 explanation, { "metric" => "distance", "value" => x["distance"], "threshold" => limit })
      end
    end

    def dsn002(r)
      by_id = r.p.modules.to_h { |ns| [ns.id, ns] }
      NomosRuby.components(r.graphs.runtime_modules).each do |cycle|
        ns = by_id[cycle.first]
        next unless ns

        r.report("high", module_place(ns), ns.id, "", tx("Module cycle: {0}", cycle.join(" <-> ")),
                 tx("These modules depend on each other, directly or transitively, so none can be built, tested or released alone."))
      end
      NomosRuby.components(r.graphs.runtime_units).each do |cycle|
        unit = r.p.types[cycle.first] || r.p.functions[cycle.first]
        next unless unit

        r.report("high", unit.place, unit.namespace.id, cycle.first, tx("Type cycle of {0}: {1}", cycle.size, cycle.map { |c| NomosRuby.simple_name(c) }.join(" <-> ")),
                 tx("These units reference each other, so a change to one can ripple through all of them."), nil, "minor")
      end
    end

    def dsn003(r)
      return if r.config.layers.empty?

      r.edges.each do |e|
        next if e.external || e.kind == "import"

        source_module = r.graphs.module_of[e.source]
        target_module = r.graphs.module_of[e.to]
        next if source_module.nil? || target_module.nil? || source_module.equal?(target_module)

        source = r.config.layer_of(source_module.id)
        target = r.config.layer_of(target_module.id)
        allowed = source ? source["mayDependOn"] || [] : []
        next if source.nil? || target.nil? || source["name"] == target["name"] || allowed.include?(target["name"])

        explanation = if allowed.empty?
                        tx("{0} ({1}) uses {2} ({3}); allowed: none.", NomosRuby.simple_name(e.source), source_module.id, NomosRuby.simple_name(e.to), target_module.id)
                      else
                        tx("{0} ({1}) uses {2} ({3}); allowed: {4}.", NomosRuby.simple_name(e.source), source_module.id, NomosRuby.simple_name(e.to), target_module.id, allowed.join(", "))
                      end
        r.report("high", e.place, source_module.id, e.source, tx("{0} must not depend on {1}", source["name"], target["name"]), explanation)
      end
    end

    def dsn004(r)
      min_wmc = r.number("minWmc")
      min_atfd = r.number("minAtfd")
      max_tcc = r.number("maxTcc")
      r.types.each do |t|
        next unless t.kind == "class"

        w = Metrics.wmc(t)
        a = Metrics.atfd(r.p, t)
        c = Metrics.tcc(r.p, t)
        next unless w >= min_wmc && a >= min_atfd && c && c < max_tcc

        r.report("low", t.place, t.namespace.id, t.id, tx("{0} looks like a god class", t.name),
                 tx("WMC = {0} (>= {1}), ATFD = {2} (>= {3}), TCC = {4} (< {5}): it does much, uses others' data, and its methods share little.",
                    w, min_wmc, a, min_atfd, fixed(c, 2), fixed(max_tcc, 2)), { "metric" => "wmc", "value" => w, "threshold" => min_wmc })
      end
    end

    def dsn005(r)
      limit = r.number("minForeignMembers")
      r.functions.each do |f|
        next unless Metrics.instance_method?(f)

        owner, names = Metrics.most_used_foreign(r.p, f)
        own = Metrics.member_use(r.p, f)[0].size
        next unless names.size >= limit && names.size > own

        r.report("low", f.place, f.namespace.id, f.id, tx("{0} is more interested in {1} than in {2}", f.name, NomosRuby.simple_name(owner), f.owner.name),
                 tx("It uses {0} members of {1} ({2}) and {3} of its own.", names.size, owner, names.join(", "), own),
                 { "metric" => "foreignMembers", "value" => names.size, "threshold" => limit })
      end
    end

    def dsn006(r)
      limit = r.number("maxDependents")
      r.p.all_types.each do |t|
        radius = r.graphs.radius.fetch(t.id, 0)
        next unless radius > limit

        r.report("medium", t.place, t.namespace.id, t.id, tx("Changing {0} can reach {1} units", t.name, radius),
                 tx("Stable abstractions at such points limit the spread. Static dependencies overstate real impact when a change keeps the contract."),
                 { "metric" => "blastRadius", "value" => radius, "threshold" => limit })
      end
    end

    def fun005(r)
      max_order = r.number("maxOrder")
      max_lambdas = r.number("maxLambdaNesting")
      r.functions.each do |f|
        order = Metrics.hof_order(r.p, f)
        if order > max_order
          r.report("medium", f.place, f.namespace.id, f.id, tx("{0} has order {1}", f.name, order), tx("The signature nests function types beyond order {0}.", max_order),
                   { "metric" => "hofOrder", "value" => order, "threshold" => max_order })
        end
        nesting = Metrics.lambda_nesting(f)
        next unless nesting > max_lambdas

        r.report("medium", f.place, f.namespace.id, f.id, tx("{0} nests lambdas {1} levels deep", f.name, nesting),
                 tx("Beyond {0} levels, captured variables are hard to trace; named functions help.", max_lambdas),
                 { "metric" => "lambdaNesting", "value" => nesting, "threshold" => max_lambdas })
      end
    end

    def mnt001(r)
      limit = r.number("maxComplexity")
      r.functions.each do |f|
        complexity = Metrics.cyclomatic(f)
        next if !f.has_body || complexity <= limit

        r.report("high", f.place, f.namespace.id, f.id, tx("{0} has cyclomatic complexity {1}", f.name, complexity),
                 tx("The count is exact; above {0}, the number of paths to test and to understand grows quickly.", limit),
                 { "metric" => "cyclomatic", "value" => complexity, "threshold" => limit }, complexity > limit * 2 ? "major" : nil)
      end
    end

    def mnt002(r)
      limit = r.number("minIndex")
      r.functions.each do |f|
        index = Metrics.maintainability_index(f)
        next if !f.has_body || index.nil? || index >= limit

        r.report("medium", f.place, f.namespace.id, f.id, tx("{0} has a maintainability index of {1}", f.name, fixed(index, 0)),
                 tx("Below {0}. The formula is an empirical blend of size and complexity, useful for ranking rather than as a measure of quality.", limit),
                 { "metric" => "maintainabilityIndex", "value" => round_to(index, 4), "threshold" => limit })
      end
    end

    def normalized(file, ids)
      file.tokens.reject { |t| file.import_lines.include?(t.line) }.map do |t|
        text = case t.kind
               when "name" then "$id"
               when "number", "string" then "$lit"
               else t.text
               end
        ids[text] ||= ids.size + 1
        [ids[text], t.line]
      end
    end

    def mnt003(r)
      window = r.number("minTokens")
      base = 1_000_003
      modulus = 1_000_000_007
      ids = {}
      files = r.p.files.map { |file| [file, normalized(file, ids)] }.select { |x| x[1].size >= window }.map { |file, tokens| [file, tokens, tokens.map(&:first)] }
      power = 1
      (1...window).each { power = power * base % modulus }
      seen = Hash.new { |h, k| h[k] = [] }
      files.each_with_index do |(file, tokens, values), index|
        h = 0
        window.times { |i| h = (h * base + values[i]) % modulus }
        skip_until = 0
        at = 0
        # For a distance d inside this file, a stretch [from, to) where every token equals the one d tokens later. A
        # match in the same file that reaches the current position is dropped; in a repeated table every earlier place
        # is such a match, and this saves comparing the same stretch again at each position.
        periodic = {}
        while at + window <= values.size
          if at.positive?
            h = (h - values[at - 1] * power % modulus + modulus) % modulus
            h = (h * base + values[at + window - 1]) % modulus
          end
          if at >= skip_until
            seen.fetch(h, []).each do |earlier_file, earlier_at|
              same = earlier_file == index
              # In the same file a match that starts less than a window back always overlaps: no need to compare.
              next if same && earlier_at + window > at

              distance = at - earlier_at
              known = same ? periodic[distance] : nil
              next if known && earlier_at >= known[0] && earlier_at + distance < known[1]

              other = files[earlier_file][2]
              length = 0
              length += 1 while earlier_at + length < other.size && at + length < values.size && other[earlier_at + length] == values[at + length]
              periodic[distance] = [earlier_at, earlier_at + length] if same
              next if length < window || (same && earlier_at + length > at)

              skip_until = at + length
              place = Place.new(file.path, tokens[at][1], 1, tokens[at + length - 1][1], 1)
              r.report("high", place, "", "", tx("{0} tokens duplicate {1}:{2}", length, files[earlier_file][0].path, files[earlier_file][1][earlier_at][1]),
                       tx("The token sequences are identical after replacing identifiers and literals with placeholders."),
                       { "metric" => "cloneTokens", "value" => length, "threshold" => window })
              break
            end
          end
          seen[h] << [index, at]
          at += 1
        end
      end
    end

    def mnt004(r)
      return if r.coverage.nil?

      limit = r.number("minCoverage")
      report = r.config.threshold(r.rule, "report").to_s
      r.p.files.each do |f|
        percent = r.coverage.percent(f.path)
        next unless percent && percent < limit

        r.report("high", file_place(f.path), "", "", tx("{0} has {1}% line coverage", f.path, fixed(percent, 0)),
                 tx("Measured from {0}; below the {1}% minimum. Coverage shows what ran, not what was verified.", report, limit),
                 { "metric" => "coverage", "value" => percent, "threshold" => limit })
      end
    end

    def oop002(r)
      limit = r.number("maxDepth")
      r.types.each do |t|
        next unless t.kind == "class"

        depth = Metrics.dit(r.p, t)
        next unless depth > limit

        r.report("medium", t.place, t.namespace.id, t.id, tx("{0} sits {1} levels deep", t.name, depth),
                 tx("The depth counts base classes in the project; a base outside it is one step. Beyond {0} levels, behavior is spread over many classes. Composition often reads better.", limit),
                 { "metric" => "dit", "value" => depth, "threshold" => limit })
      end
    end

    def oop003(r)
      limit = r.number("minTypeTests")
      r.functions.each do |f|
        tested = Metrics.tested_types(r.p, f)
        next unless tested.size >= limit

        r.report("medium", f.place, f.namespace.id, f.id, tx("{0} branches on {1} runtime types", f.name, tested.size),
                 tx("It tests for {0}. A virtual member on their common base would dispatch without the checks.", tested.map { |x| NomosRuby.simple_name(x) }.join(", ")),
                 { "metric" => "typeTests", "value" => tested.size, "threshold" => limit })
      end
    end

    def oop004(r)
      max_lcom = r.number("maxLcom")
      min_methods = r.number("minMethods")
      r.types.each do |t|
        next unless t.kind == "class"

        lcom = Metrics.lcom4(r.p, t)
        next unless lcom && lcom > max_lcom && Metrics.class_methods(t).size >= min_methods

        r.report("medium", t.place, t.namespace.id, t.id, tx("{0} splits into {1} unrelated method groups", t.name, lcom),
                 tx("LCOM4 finds method groups that share no field and do not call each other; each may be a separate class."),
                 { "metric" => "lcom4", "value" => lcom, "threshold" => max_lcom })
      end
    end

    def oop005(r)
      limit = r.number("maxCoupling")
      r.types.each do |t|
        next unless t.kind == "class"

        coupling = r.cbo(t)
        next unless coupling > limit

        r.report("low", t.place, t.namespace.id, t.id, tx("{0} depends on {1} types", t.name, coupling),
                 tx("Beyond {0} collaborators, changes elsewhere are likely to reach this class.", limit), { "metric" => "cbo", "value" => coupling, "threshold" => limit })
      end
    end

    def boolean_operators(node)
      return 0 if node.nil? || %i[block_node lambda_node].include?(node.type)

      own = %i[and_node or_node].include?(node.type) ? 1 : 0
      own + node.compact_child_nodes.sum { |c| boolean_operators(c) }
    end

    def prn007(r)
      limit = r.number("maxBooleanOperators")
      r.functions.each do |f|
        Metrics.walk_body(f) do |n|
          if Compat.ternary?(n)
            branches = [Compat.statements(n.statements).first, Compat.statements(Compat.subsequent(n)&.statements).first]
            if branches.any? { |b| b && Compat.ternary?(b) }
              r.report("medium", r.place(f, n), f.namespace.id, f.id, tx("Nested ternary expression"),
                       tx("A ternary inside a ternary hides the branching; an if or a switch expression shows it."))
            end
          end
          next unless %i[if_node unless_node while_node until_node].include?(n.type)

          operators = boolean_operators(n.predicate)
          next unless operators > limit

          r.report("medium", r.place(f, n.predicate), f.namespace.id, f.id, tx("Condition combines {0} boolean operators", operators),
                   tx("More than {0} operators in one condition; named intermediate values or a predicate method would state the intent.", limit))
        end
      end
    end

    SECRET_NAME = /password|passwd|pwd|secret|api_?key|apikey|access_?token|auth_?token|private_?key/i.freeze
    KNOWN_CREDENTIAL = /AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{32,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,}/.freeze
    SQL_TEXT = /\b(SELECT\s[\s\S]+\sFROM|INSERT\s+INTO|UPDATE\s[\s\S]+\sSET|DELETE\s+FROM|DROP\s+TABLE)\b/i.freeze
    NAMED_WRITES = %i[local_variable_write_node instance_variable_write_node class_variable_write_node global_variable_write_node
                      constant_write_node].to_set.freeze

    # The innermost function around a node; the functions come sorted by their first line.
    def owner_of(functions, node)
      line = node.location.start_line
      best = nil
      functions.each do |f|
        break if f.node.location.start_line > line

        best = f if line <= f.node.location.end_line
      end
      best ? best.id : ""
    end

    def sec001(r)
      by_file = r.p.functions.values.group_by(&:file)
      r.p.files.each do |file|
        next unless file.tree

        ns = file.module
        functions = by_file.fetch(file, []).sort_by { |f| f.node.location.start_line }
        Compat.walk(file.tree) do |n|
          owner = -> { owner_of(functions, n) }
          if NAMED_WRITES.include?(n.type)
            check_secret(r, file, ns, n.name.to_s.delete_prefix("$").delete_prefix("@@").delete_prefix("@"), n.value, owner)
          elsif n.type == :call_node && n.name.to_s.end_with?("=") && n.receiver && !%i[== != <= >= === []=].include?(n.name)
            check_secret(r, file, ns, n.name.to_s.chomp("="), Compat.arguments(n).first, owner)
          elsif n.type == :assoc_node && %i[symbol_node string_node].include?(n.key.type)
            check_secret(r, file, ns, n.key.unescaped.to_s, n.value, owner)
          end
        end
      end
    end

    def check_secret(r, file, ns, name, value, entity)
      return unless value&.type == :string_node

      name = NomosRuby.utf8(name)
      text = NomosRuby.utf8(value.unescaped)
      return if text.length < 6
      return unless KNOWN_CREDENTIAL.match?(text) || SECRET_NAME.match?(name)

      place = r.p.place(file, value)
      if KNOWN_CREDENTIAL.match?(text)
        r.report("high", place, ns.id, entity.call, tx("{0} holds what looks like a real credential", name),
                 tx("Heuristic: the literal matches the format of a known key or token. Rotate it if it is real, and load it from a secret store."), nil, "critical")
      elsif SECRET_NAME.match?(name) && !text.match?(/[ {]/)
        r.report("medium", place, ns.id, entity.call, tx("{0} looks like a hardcoded secret", name),
                 tx("Heuristic: the name suggests a secret and the value is a literal. It may be a placeholder or a non-secret value."))
      end
    end

    def plus_parts(node)
      return plus_parts(node.receiver) + Compat.arguments(node).flat_map { |a| plus_parts(a) } if node.type == :call_node && node.name == :+ && node.receiver && Compat.arguments(node).size == 1

      [node]
    end

    # The constant text of a string built at run time and whether any part is not constant, or nil.
    def sql_parts(node)
      case node.type
      when :interpolated_string_node
        text = node.parts.select { |x| x.type == :string_node }.map { |x| NomosRuby.utf8(x.unescaped) }.join(" ")
        [text, node.parts.any? { |x| x.type != :string_node }]
      when :call_node
        if node.name == :+ && node.receiver && Compat.arguments(node).size == 1
          parts = plus_parts(node)
          return nil unless parts.any? { |x| %i[string_node interpolated_string_node].include?(x.type) }

          text = +""
          dynamic = false
          parts.each do |part|
            if part.type == :string_node
              text << NomosRuby.utf8(part.unescaped)
            elsif part.type == :interpolated_string_node
              text << sql_parts(part)[0]
              dynamic = true
            else
              dynamic = true
            end
          end
          [text, dynamic]
        elsif node.name == :% && node.receiver&.type == :string_node
          [NomosRuby.utf8(node.receiver.unescaped), Compat.arguments(node).any? { |a| !%i[string_node integer_node].include?(a.type) }]
        elsif node.receiver.nil? && %i[format sprintf].include?(node.name) && Compat.arguments(node).first&.type == :string_node
          args = Compat.arguments(node)
          [NomosRuby.utf8(args.first.unescaped), args.size > 1]
        end
      end
    end

    def sec003(r)
      r.p.modules.each do |ns|
        Paradigms.module_functions(ns).each do |f|
          inner = Set.new
          Metrics.walk_body(f) do |n|
            next if inner.include?(n.object_id)

            parts = sql_parts(n)
            next if parts.nil?

            Compat.walk(n) { |x| inner << x.object_id unless x.equal?(n) }
            text, dynamic = parts
            next unless dynamic && SQL_TEXT.match?(text)

            r.report("medium", r.place(f, n), ns.id, f.id, tx("SQL built from non-constant values"),
                     tx("Heuristic: if any value comes from a user, this allows injection. Parameterized queries keep data out of the statement."))
          end
        end
      end
    end

    def str002(r)
      r.p.modules.each do |ns|
        next unless r.applies?(ns)

        ns.globals.each do |g|
          r.report("high", g.place, ns.id, "", tx("Global variable {0}", g.name), tx("Any function can change it, so its value depends on the call history."))
        end
        ns.types.each do |t|
          t.members.each do |member|
            next unless member.is_static && member.mutable && (member.name.start_with?("@@") || member.visibility != "private")

            r.report("high", r.p.place(member.file, member.node), ns.id, t.id, tx("Global mutable field {0}.{1}", t.name, member.name),
                     tx("A non-private static mutable field is shared by all code and threads."))
          end
        end
      end
    end

    def str003(r)
      max_module = r.number("maxModuleLines")
      max_file = r.number("maxFileLines")
      r.p.modules.each do |ns|
        next unless r.applies?(ns)

        loc = ns.files.sum(&:loc)
        if loc > max_module
          r.report("high", module_place(ns), ns.id, "", tx("Module {0} has {1} lines of code", ns.id, loc),
                   tx("The limit is {0}; a smaller module is easier to understand as a unit.", max_module), { "metric" => "loc", "value" => loc, "threshold" => max_module })
        end
        ns.files.each do |file|
          next unless file.lines > max_file

          r.report("high", file_place(file.path), "", "", tx("{0} has {1} lines", file.path, file.lines), tx("The limit is {0}.", max_file),
                   { "metric" => "lines", "value" => file.lines, "threshold" => max_file })
        end
      end
    end
  end

  DETECTORS = SUPPORTED.to_h { |id| [id, Detectors.method(id.downcase)] }.freeze

  def self.sort_findings(findings)
    seen = Set.new
    unique = findings.select do |f|
      key = [f.rule, f.place.file, f.place.start_line, f.place.start_column, f.place.end_line, f.place.end_column, f.message]
      seen.add?(key)
    end
    unique.sort_by { |f| [f.place.file, f.place.start_line, f.place.start_column, f.rule, f.message] }
  end
end
