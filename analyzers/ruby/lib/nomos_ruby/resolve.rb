# frozen_string_literal: true

require "set"
require_relative "project"

# Constants by lexical nesting and ancestors, methods by receiver, and the types Ruby code states by explicit creation
# (D-061): there is no type checker, so a receiver of unknown type gives no edge.
module NomosRuby
  TypeRef = Struct.new(:type)
  NsRef = Struct.new(:path)
  FnRef = Struct.new(:fn, :through_type)
  MemberRef = Struct.new(:member, :through_type)
  ExtRef = Struct.new(:id, :stdlib)
  GlobalRef = Struct.new(:glob)
  # A value whose type is known: an instance of a project type or a core kind (array, hash, string, set, range).
  Value = Struct.new(:type, :builtin, :element)

  # Core classes and the standard library (default gems) by their top-level constant; fixed, so that the output does
  # not depend on the Ruby the analyzer runs on.
  STDLIB = %w[
    ARGF ARGV ArgumentError Array BasicObject Binding Class ClosedQueueError Comparable Complex ConditionVariable DATA Data
    Dir ENV EOFError Encoding EncodingError Enumerable Enumerator Errno Exception FalseClass Fiber FiberError File FileTest
    Float FloatDomainError FrozenError GC Hash IO IOError IndexError Integer Interrupt KeyError Kernel LoadError
    LocalJumpError Marshal MatchData Math Method Module Mutex NameError NilClass NoMatchingPatternError
    NoMatchingPatternKeyError NoMethodError NotImplementedError Numeric Object ObjectSpace Proc Process Queue RUBY_ENGINE
    RUBY_PLATFORM RUBY_VERSION Ractor Random Range RangeError Rational Refinement Regexp RegexpError RubyVM RuntimeError
    STDERR STDIN STDOUT ScriptError SecurityError Set Signal SignalException SizedQueue StandardError StopIteration
    String Struct Symbol SyntaxError SystemCallError SystemExit Thread ThreadError Time TracePoint TrueClass TypeError
    UnboundMethod UncaughtThrowError Warning ZeroDivisionError
    Base64 Benchmark BigDecimal CGI CSV Coverage DRb Date DateTime Delegator DelegateClass Digest ERB English Etc Fcntl
    Fiddle FileUtils Find Forwardable GetoptLong IPAddr IRB JSON Logger Monitor MonitorMixin Net Observable Open3
    OpenSSL OpenStruct OpenURI OptionParser PP PStore Pathname Prism Psych Racc RDoc Readline Reline Resolv Ripper
    SecureRandom Shellwords SimpleDelegator Singleton Socket StringIO StringScanner Syslog TCPServer TCPSocket TSort
    Tempfile Timeout UDPSocket URI UNIXSocket WeakRef YAML Zlib
  ].to_set.freeze

  BUILTIN_CLASSES = { "Array" => "array", "Hash" => "hash", "String" => "string", "Set" => "set" }.freeze
  NOT_BASE_CLASSES = %w[Object BasicObject Struct Data].to_set.freeze
  ELEMENT_METHODS = %i[first last sample min max find detect fetch dig shift pop].to_set.freeze
  SAME_COLLECTION = %i[select filter reject sort sort_by uniq compact reverse dup clone take drop to_a].to_set.freeze

  # Where an expression is read: the function and type around it, its lexical nesting and its local names.
  class Scope
    attr_accessor :fn, :owner, :static, :nesting, :locals, :values, :module_path, :file

    def initialize(fn: nil, owner: nil, static: false, nesting: [], module_path: nil, file: nil)
      @fn = fn
      @owner = owner
      @static = static
      @nesting = nesting
      @module_path = module_path
      @locals = Set.new
      @values = {}
      @file = file
    end
  end

  class Resolver
    attr_reader :p

    def initialize(project)
      @p = project
      @scopes = {}
      @member_values = {}
      @returns = {}
    end

    # Linking ------------------------------------------------------------------------------------------------------
    def link
      @p.all_types.each { |t| link_bases(t) }
      @p.all_functions.each { |f| link_function(f) }
      @p.all_types.each do |t|
        t.is_abstract ||= t.methods.any?(&:is_abstract) if t.kind == "class"
        declare_variables(t)
      end
      declare_globals
    end

    def type_scope(t, d)
      key = [:type, t.id, d.object_id]
      @scopes[key] ||= Scope.new(owner: t, static: true, nesting: d.nesting.drop(1), file: d.file)
    end

    def link_bases(t)
      t.decls.each do |d|
        next unless d.node.type == :class_node && d.node.superclass

        superclass = d.node.superclass
        scope = Scope.new(owner: nil, static: true, nesting: d.nesting.drop(1), file: d.file)
        if superclass.type == :call_node && @p.struct_call(superclass)
          t.record = true
          t.frozen = @p.struct_call(superclass) == :data
          d.struct = @p.struct_call(superclass)
          Compat.arguments(superclass).select { |a| a.type == :symbol_node }.each_with_index do |a, i|
            next if t.members.any? { |m| m.name == a.unescaped.to_s }

            m = Member.new(a.unescaped.to_s, "property", a, t, "public", false, d.struct == :struct, [d.file.index, a.location.start_offset, i], d.file)
            m.writer = d.struct == :struct
            t.members << m
          end
          next
        end
        t.superclass ||= [superclass, d]
        ref = constant(superclass, scope)
        case ref
        when TypeRef
          t.parent ||= ref.type unless ref.type == t
          t.project_bases << ref.type unless t.project_bases.include?(ref.type) || ref.type == t
        when ExtRef
          t.parent_external ||= ref.id
          t.external_bases << ref.id unless t.external_bases.include?(ref.id)
        end
      end
      t.mixins.each do |call, d|
        scope = type_scope(t, d)
        Compat.arguments(call).each do |a|
          ref = constant(a, scope)
          t.project_bases << ref.type if ref.is_a?(TypeRef) && !t.project_bases.include?(ref.type) && ref.type != t
        end
      end
    end

    # A method whose body only raises NotImplementedError is abstract: the Ruby way to declare one.
    def link_function(f)
      statements = Compat.statements(f.node.body)
      return unless statements.size == 1

      s = statements.first
      return unless s.type == :call_node && s.receiver.nil? && %i[raise fail].include?(s.name)

      first = Compat.arguments(s).first
      first = first.receiver if first&.type == :call_node && first.name == :new
      parts = first && Compat.constant_parts(first)
      return unless parts && parts[0].last == "NotImplementedError"

      f.is_abstract = true
      f.has_body = false
    end

    WRITES = %i[instance_variable_write_node instance_variable_operator_write_node instance_variable_or_write_node
                instance_variable_and_write_node instance_variable_target_node].to_set.freeze
    CLASS_WRITES = %i[class_variable_write_node class_variable_operator_write_node class_variable_or_write_node
                      class_variable_and_write_node class_variable_target_node].to_set.freeze

    # Instance variables of the methods, class variables and class-level instance variables become members.
    def declare_variables(t)
      t.decls.each do |d|
        @p.body_items(d.body) do |kind, node, info|
          next unless kind == :code

          walk_code(node) do |n|
            if CLASS_WRITES.include?(n.type)
              class_variable(t, n, d, nil)
            elsif WRITES.include?(n.type)
              add_variable(t, n, d, nil, true)
            end
          end
        end
      end
      t.methods.sort_by { |f| [f.file.index, f.node.location.start_offset] }.each_with_index do |f, i|
        Compat.walk(f.node) do |n|
          if CLASS_WRITES.include?(n.type)
            class_variable(t, n, nil, f)
          elsif WRITES.include?(n.type)
            add_variable(t, n, nil, f, f.is_static, i)
          end
        end
      end
      t.members.sort_by!(&:order)
    end

    # Nodes of class-body code, without nested classes, modules and methods: those are members of their own.
    def walk_code(node, &blk)
      return if node.nil? || %i[class_node module_node def_node singleton_class_node].include?(node.type)

      yield node
      node.compact_child_nodes.each { |c| walk_code(c, &blk) }
    end

    def value_node(n)
      n.respond_to?(:value) ? n.value : nil
    end

    def add_variable(t, n, d, f, static, index = 0)
      name = n.name.to_s
      plain = name.delete_prefix("@")
      known = t.members.find { |m| (m.name == name || (m.kind == "property" && m.name == plain)) && m.is_static == static }
      outside_constructor = f.nil? ? false : f.kind != "constructor"
      operator = n.type != :instance_variable_write_node && n.type != :instance_variable_target_node
      if known
        known.mutable = true if outside_constructor || operator
        if known.value.nil? && value_node(n) && n.type == :instance_variable_write_node
          known.value = value_node(n)
          known.value_fn = f
        end
        return
      end
      order = f ? [10**9, index, n.location.start_offset] : [d.file.index, n.location.start_offset]
      m = Member.new(name, "field", n, t, "private", static, outside_constructor || operator, order, f ? f.file : d.file)
      if n.type == :instance_variable_write_node
        m.value = value_node(n)
        m.value_fn = f
      end
      t.members << m
    end

    def class_variable(t, n, d, f)
      name = n.name.to_s
      known = t.members.find { |m| m.name == name }
      if known
        known.mutable = true
        return
      end
      order = f ? [10**9, 0, n.location.start_offset] : [d.file.index, n.location.start_offset]
      m = Member.new(name, "field", n, t, "private", true, !f.nil? || n.type != :class_variable_write_node, order, f ? f.file : d.file)
      m.value = value_node(n) if n.type == :class_variable_write_node
      t.members << m
    end

    GLOBAL_WRITES = %i[global_variable_write_node global_variable_operator_write_node global_variable_or_write_node
                       global_variable_and_write_node global_variable_target_node].to_set.freeze

    # Global variables a project assigns are shared state of the namespace where the first assignment is.
    def declare_globals
      @p.files.each do |file|
        next unless file.tree

        visit = lambda do |node, nesting|
          if %i[class_node module_node].include?(node.type)
            path = @p.path_of(node.constant_path, nesting)
            inner = path ? [path] + nesting : nesting
            node.compact_child_nodes.each { |c| visit.call(c, inner) }
            next
          end
          if GLOBAL_WRITES.include?(node.type) && !@p.globals.key?(node.name.to_s)
            path = nesting.find { |n| @p.namespace_paths.include?(n) } || nesting.map { |n| @p.namespace_of(n) }.first || GLOBAL
            ns = @p.namespace(path)
            g = Global.new(node.name.to_s, node.name.to_s, @p.place(file, node.respond_to?(:name_loc) ? node.name_loc : node), node, ns)
            @p.globals[g.name] = g
            ns.globals << g
          end
          node.compact_child_nodes.each { |c| visit.call(c, nesting) }
        end
        visit.call(file.tree, [])
      end
    end

    # Scopes -------------------------------------------------------------------------------------------------------
    def scope_of(f)
      key = [:fn, f.id]
      return @scopes[key] if @scopes.key?(key)

      scope = Scope.new(fn: f, owner: f.owner, static: f.is_static, nesting: f.nesting, module_path: f.module_path, file: f.file)
      @scopes[key] = scope
      Compat.walk(f.node) do |n|
        scope.locals.merge(n.locals.map(&:to_s)) if n.respond_to?(:locals) && %i[def_node block_node lambda_node].include?(n.type)
      end
      f.doc_params.each do |name, text|
        value = type_value(text, scope)
        scope.values[name] = value if value
      end
      Compat.walk(f.node) do |n|
        case n.type
        when :local_variable_write_node
          value = value_of(n.value, scope)
          scope.values[n.name.to_s] ||= value if value
        when :call_node
          block = Compat.block(n)
          next unless block && n.receiver

          element = value_of(n.receiver, scope)&.element
          params = block_params(block)
          scope.values[params.first] ||= element if element && params.first
        when :for_node
          element = value_of(n.collection, scope)&.element
          scope.values[n.index.name.to_s] ||= element if element && n.index.respond_to?(:name)
        end
      end
      scope
    end

    def block_params(block)
      params = block.parameters
      return [] unless params && params.type == :block_parameters_node && params.parameters

      params.parameters.requireds.map { |r| r.respond_to?(:name) ? r.name.to_s : nil }
    end

    def module_scope(file)
      Scope.new(file: file)
    end

    # Constants ----------------------------------------------------------------------------------------------------
    def type_or_namespace(path)
      t = @p.types[path]
      return TypeRef.new(t) if t
      return NsRef.new(path) if @p.namespace_paths.include?(path)

      nil
    end

    def ancestors(t, seen = Set.new)
      return [] if t.nil? || seen.include?(t)

      seen << t
      [t] + t.project_bases.flat_map { |b| ancestors(b, seen) }
    end

    # What a constant or constant path names, or nil when it is not a constant.
    def constant(node, scope)
      parts = Compat.constant_parts(node)
      return nil if parts.nil?

      constant_names(parts[0], parts[1], scope)
    end

    def constant_names(names, absolute, scope)
      head = nil
      if absolute
        head = type_or_namespace(names.first)
      else
        scope.nesting.each do |n|
          head = type_or_namespace("#{n}::#{names.first}")
          break if head

          if names.size == 1 && (owner = @p.types[n]) && (member = owner.members.find { |m| m.kind == "constant" && m.name == names.first })
            return MemberRef.new(member, true)
          end
        end
        if head.nil? && scope.owner
          ancestors(scope.owner).each do |a|
            head = type_or_namespace("#{a.id}::#{names.first}")
            break if head

            if names.size == 1 && (member = a.members.find { |m| m.kind == "constant" && m.name == names.first })
              return MemberRef.new(member, true)
            end
          end
        end
        head ||= type_or_namespace(names.first)
      end
      return ExtRef.new(names.join("::"), STDLIB.include?(names.first)) if head.nil?

      names.drop(1).each do |name|
        path = head.is_a?(TypeRef) ? head.type.id : head.path
        nxt = type_or_namespace("#{path}::#{name}")
        if nxt.nil?
          if head.is_a?(TypeRef) && (member = ancestors(head.type).flat_map(&:members).find { |m| m.kind == "constant" && m.name == name })
            return MemberRef.new(member, true)
          end

          return nil
        end
        head = nxt
      end
      head
    end

    # Methods ------------------------------------------------------------------------------------------------------
    def lookup_instance(t, name)
      ancestors(t).each do |a|
        f = a.methods.find { |m| m.name == name && !m.is_static }
        return FnRef.new(f, false) if f

        property = a.members.find { |m| m.kind == "property" && !m.is_static && (m.name == name || "#{m.name}=" == name) }
        return MemberRef.new(property, false) if property
      end
      nil
    end

    def lookup_static(t, name)
      ancestors(t).each do |a|
        f = a.methods.find { |m| m.name == name && m.is_static }
        return FnRef.new(f, true) if f

        property = a.members.find { |m| m.kind == "property" && m.is_static && (m.name == name || "#{m.name}=" == name) }
        return MemberRef.new(property, true) if property
      end
      t.extends.each do |call, d|
        Compat.arguments(call).each do |a|
          ref = constant(a, type_scope(t, d))
          next unless ref.is_a?(TypeRef)

          found = lookup_instance(ref.type, name)
          return FnRef.new(found.fn, true) if found.is_a?(FnRef)
        end
      end
      nil
    end

    def namespace_function(path, name)
      f = @p.functions["#{path}.#{name}"]
      f && !f.owner ? FnRef.new(f, false) : nil
    end

    def global_function(name)
      f = @p.functions[name]
      f && !f.owner && f.namespace.id == GLOBAL && f.module_path.nil? ? FnRef.new(f, false) : nil
    end

    # What a call invokes: a project function, a property, the creation of a type (a TypeRef), or something outside.
    def call_target(call, scope)
      name = call.name.to_s
      receiver = call.receiver
      if receiver.nil? || receiver.type == :self_node
        if scope.owner
          found = scope.static ? lookup_static(scope.owner, name) : lookup_instance(scope.owner, name)
          return found if found
          return TypeRef.new(scope.owner) if scope.static && name == "new"
        end
        if scope.module_path
          found = namespace_function(scope.module_path, name)
          return found if found
        end
        return receiver.nil? ? global_function(name) : nil
      end
      base = constant(receiver, scope)
      case base
      when TypeRef
        return TypeRef.new(base.type) if name == "new"

        lookup_static(base.type, name) || base
      when NsRef
        namespace_function(base.path, name)
      when ExtRef
        base
      else
        value = value_of(receiver, scope)
        value&.type ? lookup_instance(value.type, name) : nil
      end
    end

    # Values -------------------------------------------------------------------------------------------------------
    YARD_COLLECTIONS = { "Array" => "array", "Set" => "set", "Enumerable" => "array", "Enumerator" => "array", "Hash" => "hash" }.freeze
    YARD_NOTHING = %w[nil NilClass void].freeze

    # Splits a YARD type list at the commas outside brackets.
    def yard_parts(text)
      parts = [+""]
      depth = 0
      text.each_char do |c|
        depth += 1 if "<{(".include?(c)
        depth -= 1 if ">})".include?(c)
        if c == "," && depth.zero?
          parts << +""
        else
          parts.last << c
        end
      end
      parts.map(&:strip).reject(&:empty?)
    end

    # The value a YARD type states: a project type, a core kind, a collection with its element; `T, nil` is T.
    def type_value(text, scope, depth = 0)
      return nil if text.nil? || depth > 4

      parts = yard_parts(text).reject { |x| YARD_NOTHING.include?(x) }
      return nil unless parts.size == 1

      t = parts.first
      if (m = t.match(/\A<(.+)>\z/))
        return Value.new(nil, "array", type_value(m[1], scope, depth + 1))
      end
      if (m = t.match(/\A(Array|Set|Enumerable|Enumerator)\s*[<(](.+)[>)]\z/))
        return Value.new(nil, YARD_COLLECTIONS[m[1]], type_value(m[2], scope, depth + 1))
      end
      if (m = t.match(/\AHash\s*\{.*=>(.+)\}\z/)) || (m = t.match(/\AHash\s*<[^,]+,(.+)>\z/))
        return Value.new(nil, "hash", type_value(m[1], scope, depth + 1))
      end
      return Value.new(nil, YARD_COLLECTIONS[t], nil) if YARD_COLLECTIONS.key?(t)
      return Value.new(nil, "string", nil) if t == "String"
      return nil unless t.match?(/\A(::)?[A-Z]\w*(::[A-Z]\w*)*\z/)

      ref = constant_names(t.delete_prefix("::").split("::"), t.start_with?("::"), scope)
      ref.is_a?(TypeRef) ? Value.new(ref.type, nil, nil) : nil
    end

    def member_value(member)
      return @member_values[member] if @member_values.key?(member)

      @member_values[member] = nil
      value = nil
      if member.doc_type
        value = type_value(member.doc_type, Scope.new(owner: member.owner, static: true, nesting: member.owner.decls.first.nesting.drop(1)))
      end
      if value.nil? && member.value
        scope = member.value_fn ? scope_of(member.value_fn) : Scope.new(owner: member.owner, static: true, nesting: member.owner.decls.first.nesting.drop(1))
        value = value_of(member.value, scope)
      end
      @member_values[member] = value
    end

    def return_value(f)
      return @returns[f] if @returns.key?(f)

      @returns[f] = nil
      documented = f.doc_return && type_value(f.doc_return, scope_of(f))
      return @returns[f] = documented if documented

      last = Compat.statements(f.node.body).last
      @returns[f] = last && f.has_body ? value_of(last, scope_of(f)) : nil
    end

    def value_of(node, scope, depth = 0)
      return nil if node.nil? || depth > 12

      case node.type
      when :array_node
        Value.new(nil, "array", node.elements.empty? ? nil : value_of(node.elements.first, scope, depth + 1))
      when :hash_node then Value.new(nil, "hash", nil)
      when :string_node, :interpolated_string_node, :x_string_node then Value.new(nil, "string", nil)
      when :range_node then Value.new(nil, "range", nil)
      when :parentheses_node
        statements = Compat.statements(node.body)
        statements.size == 1 ? value_of(statements.first, scope, depth + 1) : nil
      when :self_node
        scope.owner && !scope.static ? Value.new(scope.owner, nil, nil) : nil
      when :local_variable_read_node
        scope.values[node.name.to_s]
      when :instance_variable_read_node
        return nil unless scope.owner

        member = scope.owner.members.find { |m| (m.name == node.name.to_s || (m.kind == "property" && "@#{m.name}" == node.name.to_s)) && m.is_static == scope.static }
        member ? member_value(member) : nil
      when :call_node
        call_value(node, scope, depth)
      end
    end

    def call_value(node, scope, depth)
      name = node.name
      if node.receiver && name == :new
        ref = constant(node.receiver, scope)
        return Value.new(ref.type, nil, nil) if ref.is_a?(TypeRef)
        return Value.new(nil, BUILTIN_CLASSES[ref.id], nil) if ref.is_a?(ExtRef) && BUILTIN_CLASSES.key?(ref.id)

        return nil
      end
      if node.receiver && name == :[] && Compat.constant_parts(node.receiver)
        ref = constant(node.receiver, scope)
        return Value.new(nil, BUILTIN_CLASSES[ref.id], nil) if ref.is_a?(ExtRef) && BUILTIN_CLASSES.key?(ref.id)
      end
      if node.receiver && %i[+ * -].include?(name)
        left = value_of(node.receiver, scope, depth + 1)
        return left if left&.builtin
      end
      if node.receiver && !Compat.constant_parts(node.receiver)
        container = value_of(node.receiver, scope, depth + 1)
        if container&.builtin
          return container.element if name == :[] && container.element
          return container.element if ELEMENT_METHODS.include?(name) && Compat.arguments(node).empty? && container.element
          return container if SAME_COLLECTION.include?(name)
          return Value.new(nil, "array", nil) if %i[map collect flat_map].include?(name)
          return Value.new(nil, "string", nil) if container.builtin == "string" && %i[upcase downcase strip to_s].include?(name)

          return nil
        end
      end
      ref = call_target(node, scope)
      case ref
      when MemberRef then member_value(ref.member)
      when FnRef then return_value(ref.fn)
      when TypeRef then nil
      end
    end
  end
end
