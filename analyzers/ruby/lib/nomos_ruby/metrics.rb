# frozen_string_literal: true

require "set"
require_relative "resolve"
require_relative "text"

# Metrics of spec/metrics.md over the Prism syntax tree.
module NomosRuby
  # Iteration with a block is how Ruby loops: these calls are loops for complexity, nesting and estimates.
  LOOP_METHODS = %i[each each_with_index each_with_object each_index each_char each_byte each_line each_pair each_key
                    each_value each_slice each_cons each_entry reverse_each times upto downto step loop].to_set.freeze
  TYPE_TESTS = %i[is_a? kind_of? instance_of?].to_set.freeze
  SEPARATORS = %w[( ) { } [ ] ; , end do then].to_set.freeze

  module Metrics
    module_function

    def line_span(place)
      place.end_line - place.start_line + 1
    end

    def walk_body(f, &blk)
      f.body_nodes.each { |n| Compat.walk(n, &blk) }
    end

    def body_list(f)
      list = []
      walk_body(f) { |n| list << n }
      list
    end

    def loop_block?(n)
      n.type == :call_node && Compat.block(n) && LOOP_METHODS.include?(n.name) && (n.receiver || n.name == :loop)
    end

    def lambda?(n)
      n.type == :lambda_node || (n.type == :call_node && n.receiver.nil? && %i[lambda proc].include?(n.name) && Compat.block(n))
    end

    # 1 + decision points: if, unless, elsif, ternary, loops and iteration blocks, when conditions, in patterns,
    # rescue clauses, and/or.
    def cyclomatic(f)
      count = 1
      walk_body(f) do |n|
        case n.type
        when :if_node, :unless_node, :while_node, :until_node, :for_node, :in_node, :rescue_node, :rescue_modifier_node,
             :and_node, :or_node
          count += 1
        when :when_node
          count += n.conditions.size
        when :call_node
          count += 1 if loop_block?(n)
        end
      end
      count
    end

    # Deepest number of enclosing if, unless, case, loop, iteration block and begin with rescue; elsif stays on the
    # level of its if, a ternary is not a level.
    def max_nesting(f)
      deepest = 0
      visit = nil
      visit_if = lambda do |s, d|
        visit.call(s.predicate, d)
        visit.call(s.statements, d + 1)
        other = s.type == :if_node ? Compat.subsequent(s) : Compat.else_clause(s)
        return if other.nil?

        if other.type == :if_node && Compat.elsif?(other)
          visit_if.call(other, d)
        else
          visit.call(other, d + 1)
        end
      end
      visit = lambda do |n, d|
        return if n.nil?

        deepest = [deepest, d].max
        if %i[if_node unless_node].include?(n.type) && !Compat.ternary?(n)
          deepest = [deepest, d + 1].max
          visit_if.call(n, d)
        elsif %i[case_node case_match_node while_node until_node for_node].include?(n.type) ||
              (n.type == :begin_node && (n.rescue_clause || n.ensure_clause))
          deepest = [deepest, d + 1].max
          n.compact_child_nodes.each { |c| visit.call(c, d + 1) }
        elsif loop_block?(n)
          visit.call(n.receiver, d)
          Compat.arguments(n).each { |a| visit.call(a, d) }
          deepest = [deepest, d + 1].max
          visit.call(n.block, d + 1)
        else
          n.compact_child_nodes.each { |c| visit.call(c, d) }
        end
      end
      f.body_nodes.each { |n| visit.call(n, 0) }
      deepest
    end

    def parameter_count(f)
      f.parameter_nodes.size
    end

    def yields?(f)
      found = false
      walk_body(f) { |n| found = true if n.type == :yield_node }
      found
    end

    # The depth of functions a lambda returns: -> { -> { } } is 2.
    def lambda_depth(n, depth = 0)
      return 0 if depth > 10

      body = n.type == :lambda_node ? n.body : Compat.block(n)&.body
      last = Compat.statements(body).last
      1 + (last && lambda?(last) ? lambda_depth(last, depth + 1) : 0)
    end

    # 1 + 1 when a function takes a block (`&block` or `yield`) or calls a parameter, or the depth of the functions
    # it returns: a lambda, a proc or `method(:name)` as the result (spec/paradigms.md, Ruby).
    def hof_order(_p, f)
      depth = 0
      params = f.parameter_nodes
      names = params.map { |x| x.respond_to?(:name) && x.name ? x.name.to_s : nil }.compact.to_set
      depth = 1 if params.any? { |x| x.type == :block_parameter_node } || yields?(f)
      walk_body(f) do |n|
        next unless n.type == :call_node && %i[call ()].include?(n.name) && n.receiver&.type == :local_variable_read_node

        depth = 1 if names.include?(n.receiver.name.to_s)
      end
      returned = Compat.statements(f.node.body).last
      results = [returned]
      walk_body(f) { |n| results << Compat.arguments(n).first if n.type == :return_node && n.arguments }
      results.compact.each do |r|
        if lambda?(r)
          depth = [depth, lambda_depth(r)].max
        elsif r.type == :call_node && r.receiver.nil? && r.name == :method && Compat.arguments(r).size == 1
          depth = [depth, 1].max
        end
      end
      1 + depth
    end

    def lambda_nesting(f)
      depth = lambda do |n|
        n.compact_child_nodes.map { |c| %i[block_node lambda_node].include?(c.type) ? 1 + depth.call(c) : depth.call(c) }.max || 0
      end
      f.body_nodes.map { |n| %i[block_node lambda_node].include?(n.type) ? 1 + depth.call(n) : depth.call(n) }.max || 0
    end

    # Distinct project types a function tests at run time: is_a?, kind_of?, instance_of?, ===, when and in patterns.
    def tested_types(p, f)
      r = p.resolver
      scope = r.scope_of(f)
      seen = Set.new
      add = lambda do |node|
        ref = node && Compat.constant_parts(node) ? r.constant(node, scope) : nil
        seen << ref.type.id if ref.is_a?(TypeRef)
      end
      walk_body(f) do |n|
        case n.type
        when :call_node
          add.call(Compat.arguments(n).first) if TYPE_TESTS.include?(n.name) && Compat.arguments(n).size == 1
          add.call(n.receiver) if n.name == :=== && n.receiver
        when :when_node
          n.conditions.each { |c| add.call(c) }
        when :in_node
          pattern = n.pattern
          pattern = pattern.constant if %i[array_pattern_node find_pattern_node hash_pattern_node].include?(pattern.type) && pattern.constant
          add.call(pattern)
        end
      end
      seen.to_a.sort
    end

    # Visits every node with the number of loops whose body holds it; headers that run once are outside.
    def walk_loops(f, &visit)
      go = nil
      go = lambda do |n, depth|
        return if n.nil?

        visit.call(n, depth)
        case n.type
        when :while_node, :until_node
          go.call(n.predicate, depth + 1)
          go.call(n.statements, depth + 1)
          return
        when :for_node
          go.call(n.index, depth + 1)
          go.call(n.collection, depth)
          go.call(n.statements, depth + 1)
          return
        end
        if loop_block?(n)
          go.call(n.receiver, depth)
          Compat.arguments(n).each { |a| go.call(a, depth) }
          go.call(n.block, depth + 1)
          return
        end
        n.compact_child_nodes.each { |c| go.call(c, depth) }
      end
      f.body_nodes.each { |n| go.call(n, 0) }
    end

    # The constant a call creates an instance of: `X.new` with a constant receiver, as written.
    def class_instantiation(_p, _f, call)
      return nil unless call.type == :call_node && call.name == :new && call.receiver

      parts = Compat.constant_parts(call.receiver)
      parts ? parts[0].join("::") : nil
    end

    # Creates an object on the heap: an array or hash literal, a lambda or proc, an instance by `new`.
    def allocates(p, f, n)
      return true if %i[array_node hash_node lambda_node].include?(n.type)
      return false unless n.type == :call_node
      return true if n.receiver.nil? && %i[lambda proc].include?(n.name) && Compat.block(n)

      !class_instantiation(p, f, n).nil?
    end

    def allocation_depth(p, f)
      deepest = 0
      walk_loops(f) { |n, depth| deepest = [deepest, depth].max if allocates(p, f, n) }
      deepest
    end

    GROWING = %i[<< push append unshift prepend insert concat store add merge! update []=].to_set.freeze

    def literal_number?(n)
      %i[integer_node float_node].include?(n&.type)
    end

    # Collection growth in loops, `Array.new(n)` of non-literal size, direct recursion.
    def space_degree(p, f, self_calls)
      degree = 0
      scope = p.resolver.scope_of(f)
      walk_loops(f) do |n, depth|
        next unless n.type == :call_node

        if GROWING.include?(n.name) && n.receiver && !p.resolver.call_target(n, scope).is_a?(FnRef)
          degree = [degree, depth].max
        end
        if n.name == :new && n.receiver && Compat.constant_parts(n.receiver)&.first == ["Array"] && !Compat.arguments(n).empty? &&
           !literal_number?(Compat.arguments(n).first)
          degree = [degree, depth + 1].max
        end
      end
      degree = [degree, 1].max if self_calls.positive?
      degree
    end

    def instance_method?(f)
      f.owner && f.owner.kind == "class" && f.has_body && f.kind == "method" && !f.is_static
    end

    def own_member(t, ivar_name)
      t.members.find { |m| !m.is_static && (m.name == ivar_name || (m.kind == "property" && "@#{m.name}" == ivar_name)) }
    end

    IVARS = %i[instance_variable_read_node instance_variable_write_node instance_variable_operator_write_node
               instance_variable_or_write_node instance_variable_and_write_node instance_variable_target_node].to_set.freeze

    # Fields and properties of its own type a function touches and, by owner, those of other project classes.
    def member_use(p, f)
      @member_use ||= {}
      key = [p.object_id, f.id]
      return @member_use[key] if @member_use.key?(key)

      own = Set.new
      foreign = Hash.new { |h, k| h[k] = Set.new }
      scope = p.resolver.scope_of(f)
      walk_body(f) do |n|
        if IVARS.include?(n.type) && f.owner && !f.is_static
          member = own_member(f.owner, n.name.to_s)
          own << member if member
        elsif n.type == :call_node
          ref = p.resolver.call_target(n, scope)
          next unless ref.is_a?(MemberRef) && !ref.through_type

          member = ref.member
          next if member.is_static || member.owner.kind != "class"

          if member.owner == f.owner
            own << member
          else
            foreign[member.owner.id] << member.name
          end
        end
      end
      @member_use[key] = [own, foreign]
    end

    def most_used_foreign(p, f)
      _, foreign = member_use(p, f)
      best = ""
      # Struct and Data values are records meant to be read: using them is not envy (as data classes in Kotlin).
      owners = foreign.keys.sort.reject { |owner| p.types[owner]&.record }
      owners.each { |owner| best = owner if best.empty? || foreign[owner].size > foreign[best].size }
      best.empty? ? ["", []] : [best, foreign[best].to_a.sort]
    end

    def class_methods(t)
      t.methods.select { |m| m.kind == "method" && !m.is_static && m.has_body }
    end

    def wmc(t)
      t.methods.sum { |m| cyclomatic(m) }
    end

    # Longest chain of superclasses; a superclass outside the project is one step, mixins do not count.
    def dit(p, t, seen = Set.new)
      seen = seen | [t.id]
      if t.parent
        return 1 if seen.include?(t.parent.id) || t.parent.kind != "class"

        return 1 + dit(p, t.parent, seen)
      end
      t.parent_external && !NOT_BASE_CLASSES.include?(t.parent_external.delete_prefix("::")) ? 1 : 0
    end

    def called_functions(p, f)
      scope = p.resolver.scope_of(f)
      result = Set.new
      walk_body(f) do |n|
        next unless n.type == :call_node

        ref = p.resolver.call_target(n, scope)
        result << ref.fn if ref.is_a?(FnRef)
      end
      result
    end

    def lcom4(p, t)
      methods = class_methods(t)
      return nil if methods.empty?

      parent = (0...methods.size).to_a
      find = lambda do |i|
        i = parent[i] = parent[parent[i]] while parent[i] != i
        i
      end
      uses = methods.map { |m| member_use(p, m)[0] }
      calls = methods.map { |m| called_functions(p, m) }
      methods.each_index do |i|
        ((i + 1)...methods.size).each do |j|
          parent[find.call(i)] = find.call(j) if uses[i].intersect?(uses[j]) || calls[i].include?(methods[j]) || calls[j].include?(methods[i])
        end
      end
      (0...methods.size).map { |i| find.call(i) }.uniq.size
    end

    def tcc(p, t)
      methods = class_methods(t).reject { |m| m.visibility == "private" }
      return nil if methods.size < 2

      uses = methods.map { |m| member_use(p, m)[0] }
      connected = 0
      uses.each_index { |i| ((i + 1)...uses.size).each { |j| connected += 1 if uses[i].intersect?(uses[j]) } }
      Texts.round_to(connected / (uses.size * (uses.size - 1) / 2.0), 4)
    end

    def atfd(p, t)
      seen = Set.new
      t.methods.each { |m| member_use(p, m)[1].each { |owner, names| names.each { |n| seen << "#{owner}.#{n}" } } }
      seen.size
    end

    # The tokens of a file by line, without separators.
    def tokens_by_line(file)
      @tokens_by_line ||= {}
      @tokens_by_line[file.object_id] ||= begin
        index = Hash.new { |h, k| h[k] = [] }
        file.tokens.each { |t| index[t.line] << t.text unless SEPARATORS.include?(t.text) && %w[op keyword].include?(t.kind) }
        index
      end
    end

    # N log2 n over the tokens of the lines of a function, without separators.
    def halstead_volume(f)
      @halstead ||= {}
      return @halstead[f] if @halstead.key?(f)

      index = tokens_by_line(f.file)
      total = 0
      distinct = Set.new
      (f.place.start_line..f.place.end_line).each do |line|
        next unless index.key?(line)

        total += index[line].size
        distinct.merge(index[line])
      end
      @halstead[f] = distinct.size < 2 ? nil : total * Math.log2(distinct.size)
    end

    def maintainability_index(f)
      volume = halstead_volume(f)
      lines = line_span(f.place)
      return nil if volume.nil? || lines.zero?

      [0.0, (171 - 5.2 * Math.log(volume) - 0.23 * cyclomatic(f) - 16.2 * Math.log(lines)) * 100 / 171].max
    end
  end
end
