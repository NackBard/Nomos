# frozen_string_literal: true

require_relative "resolve"

# Structure of types and functions for facts 1.3.0, as spec/structure.md defines it for Ruby.
module NomosRuby
  module Structure
    COLLECTIONS = %w[array hash set].freeze

    module_function

    def members(p, t)
      return nil if t.members.empty?

      t.members.map do |m|
        entry = { "name" => m.name, "kind" => m.kind, "visibility" => m.visibility }
        entry["typeName"] = m.doc_type.gsub(/\s+/, " ") if m.doc_type
        value = m.kind == "constant" ? nil : p.resolver.member_value(m)
        if value
          if COLLECTIONS.include?(value.builtin)
            entry["type"] = value.element.type.id if value.element&.type
            entry["isCollection"] = true
          elsif value.type
            entry["type"] = value.type.id
          end
        end
        entry["isStatic"] = true if m.is_static
        entry
      end
    end

    def parameter_name(param)
      name = param.respond_to?(:name) && param.name ? param.name.to_s : ""
      case param.type
      when :rest_parameter_node then "*#{name}"
      when :keyword_rest_parameter_node then "**#{name}"
      when :no_keywords_parameter_node then "**nil"
      when :block_parameter_node then "&#{name}"
      when :forwarding_parameter_node then "..."
      when :required_keyword_parameter_node, :optional_keyword_parameter_node then "#{name}:"
      when :multi_target_node then param.location.slice
      else name
      end
    end

    def parameters(f)
      f.parameter_nodes.map do |param|
        entry = { "name" => parameter_name(param) }
        documented = param.respond_to?(:name) && param.name ? f.doc_params[param.name.to_s] : nil
        entry["typeName"] = documented.gsub(/\s+/, " ") if documented
        entry
      end
    end

    def return_type_name(f)
      text = f.kind == "constructor" ? nil : f.doc_return
      text && !%w[void nil].include?(text) ? text.gsub(/\s+/, " ") : nil
    end
  end
end
