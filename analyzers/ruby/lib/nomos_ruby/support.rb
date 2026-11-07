# frozen_string_literal: true

# Places, tokens and the small differences between Prism 0.19 (Ruby 3.3) and Prism 1.x (Ruby 3.4 and newer).
module NomosRuby
  Place = Struct.new(:file, :start_line, :start_column, :end_line, :end_column) do
    def to_h
      { "file" => file, "startLine" => start_line, "startColumn" => start_column, "endLine" => end_line, "endColumn" => end_column }
    end
  end

  Token = Struct.new(:line, :end_line, :kind, :text)

  # Prism renamed some fields between 0.19 and 1.x; these readers accept both.
  module Compat
    module_function

    def subsequent(node)
      if node.respond_to?(:subsequent) then node.subsequent
      elsif node.respond_to?(:consequent) then node.consequent
      elsif node.respond_to?(:else_clause) then node.else_clause
      end
    end

    def else_clause(node)
      if node.respond_to?(:else_clause) then node.else_clause
      elsif node.respond_to?(:consequent) then node.consequent
      end
    end

    def operator(node)
      value = node.respond_to?(:binary_operator) ? node.binary_operator : node.operator
      value.to_s
    end

    # The parts of a constant path (`A::B::C`), whether it starts with `::`, or nil when a part is not a constant.
    def constant_parts(node)
      case node.type
      when :constant_read_node, :constant_target_node
        [[node.name.to_s], false]
      when :constant_path_node, :constant_path_target_node
        name = node.respond_to?(:name) && !node.respond_to?(:child) ? node.name : (node.respond_to?(:child) ? node.child.name : node.name)
        return [[name.to_s], true] if node.parent.nil?

        inner = constant_parts(node.parent)
        return nil if inner.nil?

        [inner[0] + [name.to_s], inner[1]]
      end
    end

    def arguments(call)
      call.arguments ? call.arguments.arguments : []
    end

    def block(call)
      b = call.block
      b && b.type == :block_node ? b : nil
    end

    def block_argument(call)
      b = call.block
      b && b.type == :block_argument_node ? b : nil
    end

    def ternary?(node)
      node.type == :if_node && node.if_keyword_loc.nil?
    end

    def elsif?(node)
      node.type == :if_node && node.if_keyword_loc && node.if_keyword_loc.slice == "elsif"
    end

    def safe_navigation?(call)
      call.call_operator_loc && call.call_operator_loc.slice == "&."
    end

    # The statements of a body node: StatementsNode, BeginNode or nil.
    def statements(body)
      return [] if body.nil?
      return body.body if body.type == :statements_node
      return statements(body.statements) if body.type == :begin_node && body.rescue_clause.nil? && body.ensure_clause.nil? && body.else_clause.nil?

      [body]
    end

    def walk(node, &blk)
      return if node.nil?

      stack = [node]
      until stack.empty?
        current = stack.pop
        yield current
        stack.concat(current.compact_child_nodes.reverse)
      end
    end
  end

  # Text of a literal as UTF-8: a file with `# encoding: us-ascii` or binary escapes gives strings in other encodings.
  def self.utf8(text)
    text.to_s.dup.force_encoding("UTF-8").scrub
  end

  def self.ordinal_sort(list, &key)
    key ? list.sort_by { |x| key.call(x) } : list.sort
  end
end
