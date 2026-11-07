# frozen_string_literal: true

require "set"
require_relative "metrics"

# Paradigm evidence of spec/paradigms.md and the conservative definition of a pure function.
module NomosRuby
  module Paradigms
    ACTIVATING = %w[oop.classes str.free-functions str.control-flow fp.higher-order fp.pure-functions].to_set.freeze
    FLOW = %i[if_node unless_node case_node case_match_node while_node until_node for_node].to_set.freeze

    module_function

    def active(evidence)
      evidence.select { |e| ACTIVATING.include?(e["kind"]) }.map { |e| e["paradigm"] }.uniq.sort
    end

    def add(result, paradigm, kind, description, ids, count = nil)
      count ||= ids.size
      return if count.zero?

      result << { "paradigm" => paradigm, "kind" => kind, "count" => count, "description" => description, "examples" => ids.uniq.sort.first(5) }
    end

    def module_functions(ns)
      ns.functions + ns.types.flat_map(&:methods)
    end

    def control_flow?(f)
      found = false
      Metrics.walk_body(f) { |n| found = true if (FLOW.include?(n.type) && !Compat.ternary?(n)) || Metrics.loop_block?(n) }
      found
    end

    def lambdas_passed(f)
      count = 0
      Metrics.walk_body(f) do |n|
        next unless n.type == :call_node

        count += Compat.arguments(n).count { |a| Metrics.lambda?(a) || a.type == :block_argument_node }
        count += 1 if Compat.block(n) && !Metrics.loop_block?(n) && !Metrics.lambda?(n)
        count += 1 if Compat.block_argument(n)
      end
      count
    end

    def collect_evidence(p, ns, pure)
      result = []
      classes = []
      mutable = []
      inheriting = []
      abstract = []
      immutable = []
      ns.types.each do |t|
        if t.kind == "class"
          state = t.members.reject { |m| m.is_static || m.kind == "constant" }
          classes << t.id if !t.members.empty? || !t.methods.empty?
          if state.any?(&:mutable)
            mutable << t.id
          elsif !state.empty?
            immutable << t.id
          end
        end
        inheriting << t.id if !t.project_bases.empty?
        abstract << t.id if t.is_abstract
      end
      add(result, "oop", "oop.classes", "classes with methods or fields", classes)
      add(result, "oop", "oop.mutable-state-classes", "classes with mutable instance state", mutable)
      add(result, "oop", "oop.inheritance", "project types inheriting project types or including project modules", inheriting)
      add(result, "oop", "oop.abstractions", "mixin modules and abstract classes", abstract)
      add(result, "functional", "fp.immutable-types", "types whose instance state cannot change", immutable)

      free = ns.functions.map(&:id)
      flow = []
      higher = []
      pure_ids = []
      lambda_owners = []
      module_functions(ns).each do |f|
        flow << f.id if control_flow?(f)
        higher << f.id if f.has_body && Metrics.hof_order(p, f) > 1
        pure_ids << f.id if pure.include?(f)
        lambdas_passed(f).times { lambda_owners << f.id }
      end
      shared = ns.globals.map(&:id) + ns.types.flat_map { |t| t.members.select { |m| m.is_static && m.mutable }.map { |m| "#{t.id}.#{m.name}" } }
      add(result, "structural", "str.free-functions", "functions outside types", free)
      add(result, "structural", "str.control-flow", "functions with branches or loops", flow)
      add(result, "structural", "str.global-state", "global variables and mutable class-level state", shared)
      add(result, "functional", "fp.lambdas", "blocks and lambdas passed as arguments", lambda_owners, lambda_owners.size)
      add(result, "functional", "fp.higher-order", "functions taking blocks or returning functions", higher)
      add(result, "functional", "fp.pure-functions", "functions that provably have no effects (conservative)", pure_ids)
      result.sort_by { |e| e["kind"] }
    end

    # The conservative definition of spec/paradigms.md as a greatest fixed point.
    def pure_functions(p)
      pure = p.functions.values.select { |f| f.has_body && %w[function method].include?(f.kind) && locally_pure?(p, f) }.to_set
      changed = true
      while changed
        changed = false
        pure.to_a.sort_by(&:id).each do |f|
          next if calls_only_pure?(p, f, pure)

          pure.delete(f)
          changed = true
        end
      end
      pure
    end

    # Operators are methods in Ruby; arithmetic and comparison have no effect on their operands.
    OPERATORS = %i[+ - * / % ** == != < > <= >= <=> ! -@ +@ & | ^ ~ === =~].to_set.freeze
    VALUE_METHODS = %i[abs round floor ceil truncate to_s to_i to_f to_r to_sym zero? positive? negative? even? odd? nil?
                       is_a? kind_of? instance_of? frozen? length size empty? upcase downcase capitalize strip lstrip
                       rstrip start_with? end_with? include? divmod fdiv div modulo pow succ pred chr ord hash eql? equal?
                       between? clamp format].to_set.freeze
    FORBIDDEN = %i[yield_node super_node forwarding_super_node block_node lambda_node def_node class_node module_node
                   singleton_class_node global_variable_read_node global_variable_write_node class_variable_read_node
                   class_variable_write_node instance_variable_write_node instance_variable_operator_write_node
                   instance_variable_or_write_node instance_variable_and_write_node instance_variable_target_node
                   global_variable_operator_write_node class_variable_operator_write_node call_operator_write_node
                   call_or_write_node call_and_write_node index_operator_write_node index_or_write_node index_and_write_node
                   defined_node x_string_node interpolated_x_string_node back_reference_read_node].to_set.freeze

    def readable_member?(member)
      return true if member.kind == "constant"

      !member.mutable && !member.writer
    end

    def locally_pure?(p, f)
      r = p.resolver
      scope = r.scope_of(f)
      Metrics.walk_body(f) do |n|
        return false if FORBIDDEN.include?(n.type)

        case n.type
        when :instance_variable_read_node
          member = f.owner && Metrics.own_member(f.owner, n.name.to_s)
          return false unless member && readable_member?(member)
        when :call_node
          return false if n.name.to_s.end_with?("=") && !%i[== != <= >= === =~].include?(n.name)
          return false if n.name.to_s.end_with?("!") && n.name != :!
          return false if %i[<< raise fail puts print p pp warn exit abort sleep require].include?(n.name) && (n.name == :<< || n.receiver.nil?)
          return false if Compat.block_argument(n)

          ref = r.call_target(n, scope)
          if ref.is_a?(TypeRef) && n.name == :new
            t = ref.type
            return false if t.kind != "class" || t.methods.any? { |m| m.kind == "constructor" }
          end
          if ref.is_a?(MemberRef)
            return false unless readable_member?(ref.member)
          end
        when :constant_read_node, :constant_path_node
          ref = r.constant(n, scope)
          return false if ref.is_a?(MemberRef) && !readable_member?(ref.member)
        end
      end
      true
    end

    def math?(p, scope, receiver)
      ref = receiver && Compat.constant_parts(receiver) ? p.resolver.constant(receiver, scope) : nil
      ref.is_a?(ExtRef) && ref.id.delete_prefix("::") == "Math"
    end

    def calls_only_pure?(p, f, pure)
      r = p.resolver
      scope = r.scope_of(f)
      Metrics.walk_body(f) do |n|
        next unless n.type == :call_node

        next if OPERATORS.include?(n.name) && n.receiver
        next if math?(p, scope, n.receiver)

        ref = r.call_target(n, scope)
        next if ref.is_a?(TypeRef) && n.name == :new
        next if ref.is_a?(FnRef) && pure.include?(ref.fn)
        next if ref.is_a?(MemberRef) && readable_member?(ref.member)
        next if ref.nil? && n.receiver && VALUE_METHODS.include?(n.name)
        next if ref.nil? && n.receiver.nil? && n.name == :format

        return false
      end
      true
    end
  end
end
