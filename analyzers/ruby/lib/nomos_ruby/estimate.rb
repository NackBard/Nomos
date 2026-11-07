# frozen_string_literal: true

require "set"
require_relative "metrics"

# Time estimates of spec/metrics.md: n^degree · log^l n, or exponential.
module NomosRuby
  Growth = Struct.new(:degree, :log, :exponential, :uncertain) do
    def with_uncertain(value = true)
      Growth.new(degree, log, exponential, value)
    end
  end

  module Estimates
    CONSTANT = Growth.new(0, 0, false, false)
    LINEAR = Growth.new(1, 0, false, false)
    LOGARITHMIC = Growth.new(0, 1, false, false)

    LINEAR_METHODS = %i[include? index find_index rindex find detect select filter reject map collect flat_map filter_map
                        sum min max minmax min_by max_by count any? all? none? one? reduce inject join uniq flatten to_a
                        to_h to_set group_by partition tally zip find_all delete compact reverse take_while drop_while
                        each_with_object each_slice each_cons sum].to_set.freeze
    SORT_METHODS = %i[sort sort_by sort! sort_by!].to_set.freeze
    CONSTANT_LOOKUP = %i[include? member? key? has_key? delete].to_set.freeze
    MEMO_METHODS = %i[key? has_key? include? member? fetch].to_set.freeze

    module_function

    def times(a, b)
      Growth.new(a.degree + b.degree, a.log + b.log, a.exponential || b.exponential, a.uncertain || b.uncertain)
    end

    def larger(a, b)
      pick_b = (b.exponential != a.exponential && b.exponential) ||
               (b.exponential == a.exponential && (b.degree > a.degree || (b.degree == a.degree && b.log > a.log)))
      winner = pick_b ? b : a
      winner.with_uncertain(a.uncertain || b.uncertain)
    end

    def text(g)
      return "O(2ⁿ)" if g.exponential

      parts = []
      case g.degree
      when 0 then nil
      when 1 then parts << "n"
      when 2 then parts << "n²"
      when 3 then parts << "n³"
      else parts << "n^#{g.degree}"
      end
      if g.log == 1
        parts << "log n"
      elsif g.log > 1
        parts << "log^#{g.log} n"
      end
      parts.empty? ? "O(1)" : "O(#{parts.join(" ")})"
    end

    def callee_of(p, f, call)
      ref = p.resolver.call_target(call, p.resolver.scope_of(f))
      ref.is_a?(FnRef) ? ref.fn : nil
    end

    def self_calls(p, f)
      Metrics.body_list(f).select { |n| n.type == :call_node && callee_of(p, f, n).equal?(f) }
    end

    # Estimates every function with a body in ordinal id order: mutual recursion is cut at the function being estimated.
    def time_estimates(p)
      e = Estimator.new(p)
      p.all_functions.select(&:has_body).to_h { |f| [f.id, e.estimate(f)] }
    end

    def two?(n, value)
      n&.type == :integer_node && n.value == value
    end

    def divides_by_two(node)
      found = false
      Compat.walk(node) do |c|
        next unless c.type == :call_node

        arg = Compat.arguments(c).first
        found = true if (%i[/ div fdiv].include?(c.name) && two?(arg, 2)) || (c.name == :>> && two?(arg, 1))
      end
      found
    end

    OPERATOR_WRITES = %i[local_variable_operator_write_node instance_variable_operator_write_node].to_set.freeze

    # A step that divides or multiplies a counter: /=, *=, >>=, <<=, or i = i / 2.
    def halving?(n)
      return %w[/ * >> <<].include?(Compat.operator(n)) if OPERATOR_WRITES.include?(n.type)
      return divides_by_two(n.value) if %i[local_variable_write_node instance_variable_write_node].include?(n.type)

      false
    end

    def literal_range?(x)
      x.type == :range_node && Metrics.literal_number?(x.left) && (x.right.nil? || Metrics.literal_number?(x.right))
    end

    def constant_collection(x)
      return false if x.nil?
      return true if %i[array_node string_node].include?(x.type)
      return literal_range?(x) if x.type == :range_node
      return constant_collection(Compat.statements(x.body).first) if x.type == :parentheses_node && Compat.statements(x.body).size == 1

      false
    end

    def can_complete(statements)
      return true if statements.empty?

      !%i[return_node break_node next_node].include?(statements.last.type) &&
        !(statements.last.type == :call_node && statements.last.receiver.nil? && %i[raise fail].include?(statements.last.name))
    end
  end

  class Estimator
    include Estimates

    def initialize(p)
      @p = p
      @memo = {}
      @active = Set.new
      @elements = Set.new
      @current = nil
    end

    def estimate(f)
      return @memo[f] if @memo.key?(f)
      return Estimates::CONSTANT if !f.has_body || @active.include?(f)

      @active << f
      outer_elements = @elements
      outer = @current
      @elements = Set.new
      @current = f
      growth = combine(f, block(f.body_nodes))
      @elements = outer_elements
      @current = outer
      @active.delete(f)
      @memo[f] = growth
    end

    def block(nodes)
      nodes.compact.reduce(Estimates::CONSTANT) { |total, n| Estimates.larger(total, cost(n)) }
    end

    def children(n)
      block(n.compact_child_nodes)
    end

    def scope
      @p.resolver.scope_of(@current)
    end

    def bind(names)
      added = names.compact.reject { |n| @elements.include?(n) }
      added.each { |n| @elements << n }
      added
    end

    def element_walk?(x)
      return false if x.nil?

      case x.type
      when :local_variable_read_node then @elements.include?(x.name.to_s)
      when :call_node then element_walk?(x.receiver)
      else false
      end
    end

    def loop_factor(call)
      receiver = call.receiver
      case call.name
      when :times
        Metrics.literal_number?(receiver) ? Estimates::CONSTANT : Estimates::LINEAR
      when :upto, :downto, :step
        Metrics.literal_number?(receiver) && Compat.arguments(call).all? { |a| Metrics.literal_number?(a) } ? Estimates::CONSTANT : Estimates::LINEAR
      when :loop
        Estimates::LINEAR.with_uncertain
      else
        element_walk?(receiver) || Estimates.constant_collection(receiver) ? Estimates::CONSTANT : Estimates::LINEAR
      end
    end

    def cost(n)
      case n.type
      when :while_node, :until_node
        iteration = Estimates.larger(cost(n.statements || n.predicate), cost(n.predicate))
        return Estimates.times(while_factor(n.statements), iteration)
      when :for_node
        header = cost(n.collection)
        added = bind([n.index.respond_to?(:name) ? n.index.name.to_s : nil])
        iteration = n.statements ? cost(n.statements) : Estimates::CONSTANT
        added.each { |a| @elements.delete(a) }
        factor = element_walk?(n.collection) || Estimates.constant_collection(n.collection) ? Estimates::CONSTANT : Estimates::LINEAR
        return Estimates.larger(header, Estimates.times(factor, iteration))
      when :local_variable_write_node
        @elements << n.name.to_s if element_walk?(n.value)
        return cost(n.value)
      when :call_node
        return call(n)
      when :lambda_node
        return Estimates::CONSTANT
      end
      children(n)
    end

    def block_params(blk)
      @p.resolver.block_params(blk)
    end

    # The library operation a call is: :linear, :sort or nil.
    def library(call)
      return nil if call.receiver.nil?

      ref = @p.resolver.call_target(call, scope)
      return nil if ref.is_a?(FnRef) || ref.is_a?(TypeRef)

      receiver = @p.resolver.value_of(call.receiver, scope)
      return nil if receiver&.builtin == "string" && call.name != :join
      return nil if %w[hash set].include?(receiver&.builtin) && Estimates::CONSTANT_LOOKUP.include?(call.name)
      return :sort if Estimates::SORT_METHODS.include?(call.name)
      return :linear if Estimates::LINEAR_METHODS.include?(call.name)

      nil
    end

    def call(call)
      parts = call.receiver ? cost(call.receiver) : Estimates::CONSTANT
      lam = Estimates::CONSTANT
      Compat.arguments(call).each do |a|
        if Metrics.lambda?(a)
          lam = Estimates.larger(lam, cost_of_block(a.type == :lambda_node ? a : Compat.block(a), a.type == :lambda_node ? a.parameters : nil))
        else
          parts = Estimates.larger(parts, cost(a))
        end
      end
      blk = Compat.block(call)
      if Metrics.loop_block?(call)
        params = block_params(blk)
        added = bind(params)
        iteration = blk.body ? cost(blk.body) : Estimates::CONSTANT
        added.each { |a| @elements.delete(a) }
        return Estimates.larger(parts, Estimates.times(loop_factor(call), iteration))
      end
      if blk && !Metrics.lambda?(call)
        added = bind(call.receiver && element_walk?(call.receiver) ? [] : block_params(blk))
        lam = Estimates.larger(lam, blk.body ? cost(blk.body) : Estimates::CONSTANT)
        added.each { |a| @elements.delete(a) }
      end
      target = Estimates.callee_of(@p, @current, call)
      if target
        callee = estimate(target)
        callee = callee.with_uncertain if callee.degree.positive? || callee.log.positive? || callee.exponential
        return Estimates.larger(Estimates.larger(parts, lam), callee)
      end
      case library(call)
      when :sort then Estimates.larger(parts, Growth.new(1, 1, false, false))
      when :linear then Estimates.larger(parts, Estimates.times(Estimates::LINEAR, lam))
      else Estimates.larger(parts, lam)
      end
    end

    def cost_of_block(blk, _params)
      blk&.body ? cost(blk.body) : Estimates::CONSTANT
    end

    def while_factor(body)
      halves = false
      Compat.walk(body) { |c| halves = true if Estimates.halving?(c) }
      (halves ? Estimates::LOGARITHMIC : Estimates::LINEAR).with_uncertain
    end

    MEMO_WRITES = %i[instance_variable_or_write_node index_or_write_node local_variable_or_write_node call_or_write_node].to_set.freeze

    def combine(f, work)
      own = Estimates.self_calls(@p, f)
      return work if own.empty?

      half_names = Set.new
      memoized = false
      Metrics.walk_body(f) do |n|
        half_names << n.name.to_s if n.type == :local_variable_write_node && Estimates.divides_by_two(n.value)
        memoized = true if MEMO_WRITES.include?(n.type)
        memoized = true if n.type == :call_node && Estimates::MEMO_METHODS.include?(n.name) && n.receiver
      end
      halving = false
      decrements = false
      own.each do |c|
        Compat.arguments(c).each do |a|
          Compat.walk(a) do |x|
            halving = true if x.type == :local_variable_read_node && half_names.include?(x.name.to_s)
            decrements = true if x.type == :call_node && %i[- +].include?(x.name) && x.receiver
          end
          halving ||= Estimates.divides_by_two(a)
        end
      end
      per_path = calls_on_path_block(f, Compat.statements(f.node.body))
      recursion = if per_path <= 1 && halving then Estimates::LOGARITHMIC
                  elsif per_path <= 1 || halving || memoized || !decrements then Estimates::LINEAR
                  else Growth.new(0, 0, true, false)
                  end
      total = if per_path > 1 && halving
                Estimates.times(Estimates.larger(work, Estimates::LINEAR), Estimates::LOGARITHMIC)
              elsif !halving && !decrements
                Estimates.larger(work, Estimates::LINEAR)
              else
                Estimates.times(recursion, work)
              end
      total.with_uncertain
    end

    def calls_on_path(f, n)
      return 0 if n.nil?

      case n.type
      when :if_node, :unless_node
        other = n.type == :if_node ? Compat.subsequent(n) : Compat.else_clause(n)
        return calls_on_path(f, n.predicate) + [calls_on_path(f, n.statements), calls_on_path(f, other)].max
      when :case_node, :case_match_node
        branches = n.conditions.map { |w| calls_on_path(f, w.statements) }
        branches << calls_on_path(f, Compat.else_clause(n))
        return calls_on_path(f, n.predicate) + (branches.max || 0)
      when :lambda_node, :def_node
        return 0
      end
      count = n.type == :call_node && Estimates.callee_of(@p, f, n).equal?(f) ? 1 : 0
      count + n.compact_child_nodes.sum { |c| calls_on_path(f, c) }
    end

    def calls_on_path_block(f, statements)
      return 0 if statements.empty?

      first = statements.first
      rest = statements.drop(1)
      if %i[if_node unless_node].include?(first.type) && !Compat.ternary?(first)
        other = first.type == :if_node ? Compat.subsequent(first) : Compat.else_clause(first)
        if other.nil? && !Estimates.can_complete(Compat.statements(first.statements))
          return calls_on_path(f, first.predicate) + [calls_on_path_block(f, Compat.statements(first.statements)), calls_on_path_block(f, rest)].max
        end
      end
      calls_on_path(f, first) + calls_on_path_block(f, rest)
    end
  end
end
