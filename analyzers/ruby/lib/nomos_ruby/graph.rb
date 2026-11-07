# frozen_string_literal: true

require "set"
require_relative "resolve"

# Dependency edges by spec/metrics.md, the unit and module graphs, cycles and blast radius.
module NomosRuby
  Edge = Struct.new(:source, :to, :kind, :external, :stdlib, :to_type, :type_only, :place)

  NESTED_UNITS = %i[class_node module_node].to_set.freeze

  class Collector
    def initialize(project, edges)
      @p = project
      @r = project.resolver
      @edges = edges
    end

    def unit_of(ref)
      case ref
      when TypeRef then [ref.type, true]
      when FnRef then ref.fn.owner ? [ref.fn.owner, true] : [ref.fn, false]
      when MemberRef then [ref.member.owner, true]
      else [nil, false]
      end
    end

    def record(node, ref, kind)
      where = @p.place(@file, node)
      if ref.is_a?(ExtRef)
        @edges << Edge.new(@unit, ref.id, kind, true, ref.stdlib, true, false, where)
        return
      end
      target, is_type = unit_of(ref)
      return if target.nil? || target.id == @unit

      @edges << Edge.new(@unit, target.id, kind, false, false, is_type, false, where)
    end

    def type_unit(t)
      @unit = t.id
      t.decls.each do |d|
        @file = d.file
        scope = @r.type_scope(t, d)
        if d.node.type == :class_node && d.node.superclass
          superclass = d.node.superclass
          if superclass.type == :call_node && @p.struct_call(superclass)
            visit(superclass, scope)
          else
            ref = @r.constant(superclass, scope)
            ref ? record(superclass, ref, "inheritance") : visit(superclass, scope)
          end
        end
        @p.body_items(d.body) do |kind, node, info|
          case kind
          when :mixin
            Compat.arguments(node).each do |a|
              ref = @r.constant(a, scope)
              if ref.is_a?(TypeRef) || ref.is_a?(ExtRef)
                record(a, ref, node.name == :extend ? "type-ref" : "inheritance")
              else
                visit(a, scope)
              end
            end
          when :code
            visit(node, scope) unless NESTED_UNITS.include?(node.type) || (node.type == :constant_write_node && @p.struct_call(node.value))
          when :attr
            nil
          end
        end
      end
      t.methods.each do |f|
        @file = f.file
        visit_def(f)
      end
    end

    def function_unit(f)
      @unit = f.id
      @file = f.file
      visit_def(f)
    end

    def visit_def(f)
      scope = @r.scope_of(f)
      f.parameter_nodes.each { |param| visit(param.value, scope) if param.respond_to?(:value) && param.value }
      visit(f.node.body, scope) if f.node.body
    end

    def visit(node, scope)
      return if node.nil?

      case node.type
      when :class_node, :module_node, :singleton_class_node
        return
      when :def_node
        visit(node.body, scope)
        return
      when :constant_read_node, :constant_path_node
        ref = @r.constant(node, scope)
        case ref
        when TypeRef, ExtRef then record(node, ref, "type-ref")
        when MemberRef then record(node, ref, "call")
        else
          node.compact_child_nodes.each { |c| visit(c, scope) } if node.type == :constant_path_node && ref.nil? && node.parent && !Compat.constant_parts(node.parent)
        end
        return
      when :call_node
        call(node, scope)
        return
      end
      node.compact_child_nodes.each { |c| visit(c, scope) }
    end

    def call(node, scope)
      receiver = node.receiver
      constant_receiver = receiver && Compat.constant_parts(receiver)
      target = @r.call_target(node, scope)
      if constant_receiver
        ref = target || @r.constant(receiver, scope)
        ref = @r.constant(receiver, scope) if ref.is_a?(NsRef)
        record(node, ref, "call") if ref && !ref.is_a?(NsRef)
      else
        visit(receiver, scope) if receiver
        case target
        when FnRef then record(node, target, "call")
        when MemberRef then record(node, target, target.through_type ? "call" : "type-ref")
        when TypeRef then record(node, target, "call")
        end
      end
      Compat.arguments(node).each { |a| visit(a, scope) }
      visit(node.block, scope) if node.block
    end
  end

  def self.collect_edges(project)
    edges = []
    collector = Collector.new(project, edges)
    project.modules.each do |ns|
      ns.types.sort_by(&:id).each { |t| collector.type_unit(t) }
      ns.functions.sort_by(&:id).each { |f| collector.function_unit(f) }
    end
    edges
  end

  class Graph
    attr_reader :succ, :pred

    def initialize
      @succ = {}
      @pred = {}
    end

    def node(n)
      @succ[n] ||= Set.new
      @pred[n] ||= Set.new
    end

    def edge(a, b)
      node(a)
      node(b)
      @succ[a] << b
      @pred[b] << a
    end
  end

  class Graphs
    attr_reader :units, :modules, :runtime_units, :runtime_modules, :module_of, :radius

    def initialize
      @units = Graph.new
      @modules = Graph.new
      @runtime_units = Graph.new
      @runtime_modules = Graph.new
      @module_of = {}
      @radius = {}
    end
  end

  def self.build_graphs(project, edges)
    g = Graphs.new
    project.modules.each do |ns|
      g.modules.node(ns.id)
      g.runtime_modules.node(ns.id)
      (ns.types + ns.functions).each do |unit|
        g.module_of[unit.id] = ns
        g.units.node(unit.id)
        g.runtime_units.node(unit.id)
      end
    end
    edges.each do |e|
      next if e.external

      pairs = e.type_only ? [[g.units, g.modules]] : [[g.units, g.modules], [g.runtime_units, g.runtime_modules]]
      pairs.each do |units, modules|
        units.edge(e.source, e.to)
        a = g.module_of[e.source]
        b = g.module_of[e.to]
        modules.edge(a.id, b.id) if a && b && !a.equal?(b)
      end
    end
    g.units.succ.each_key { |unit| g.radius[unit] = reach(g.units, unit) }
    g
  end

  def self.reach(graph, start)
    seen = Set[start]
    queue = [start]
    until queue.empty?
      current = queue.shift
      graph.pred.fetch(current, []).each do |dependent|
        next if seen.include?(dependent)

        seen << dependent
        queue << dependent
      end
    end
    seen.size - 1
  end

  # Strongly connected components with two or more members (Tarjan), iteratively.
  def self.components(graph)
    index = {}
    low = {}
    on_stack = Set.new
    stack = []
    result = []
    counter = 0
    graph.succ.keys.sort.each do |start|
      next if index.key?(start)

      work = []
      enter = lambda do |n|
        index[n] = counter
        low[n] = counter
        counter += 1
        stack << n
        on_stack << n
        work << [n, graph.succ[n].to_a.sort]
      end
      enter.call(start)
      until work.empty?
        top = work.last
        unless top[1].empty?
          successor = top[1].shift
          if !index.key?(successor)
            enter.call(successor)
          elsif on_stack.include?(successor)
            low[top[0]] = [low[top[0]], index[successor]].min
          end
          next
        end
        work.pop
        unless work.empty?
          parent = work.last[0]
          low[parent] = [low[parent], low[top[0]]].min
        end
        next if low[top[0]] != index[top[0]]

        component = []
        loop do
          member = stack.pop
          on_stack.delete(member)
          component << member
          break if member == top[0]
        end
        result << component.sort if component.size > 1
      end
    end
    result.sort_by(&:first)
  end

  # The name of a unit without its namespace: `Shop::Cart` is `Cart`, `Shop.configure` is `configure`.
  def self.simple_name(unit_id)
    unit_id.split("::").last.split(/[.#]/).last
  end
end
