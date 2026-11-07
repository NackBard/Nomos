# frozen_string_literal: true

require "prism"
require "set"
require_relative "support"
require_relative "suppress"

# Everything loaded from a root: files, namespaces, types, functions and members (D-061).
module NomosRuby
  SKIPPED_FOLDERS = %w[node_modules vendor tmp log coverage pkg].to_set.freeze
  GLOBAL = "(global)"

  SourceFile = Struct.new(:path, :text, :lines, :loc, :tokens, :directives, :import_lines, :tree, :broken, :line_texts,
                          :comment_lines, :module, :index, :comments, keyword_init: true) do
    # Identity, not the value of all fields: a file is a hash key in many places, and its text and tokens are large.
    def hash
      object_id.hash
    end

    def eql?(other)
      equal?(other)
    end

    def ==(other)
      equal?(other)
    end

    # The comment block right above a line: consecutive lines that hold only a `#` comment.
    def doc_above(line)
      found = []
      current = line - 1
      while current >= 1 && comments.key?(current)
        found.unshift(comments[current])
        current -= 1
      end
      found
    end
  end

  # Types from YARD tags (`@param name [Type]`, `@param [Type] name`, `@return [Type]`): the documented types of
  # Ruby, read like JSDoc in JavaScript (spec/metrics.md, Ruby). They give values a type, never an edge.
  module Yard
    PARAM = /@param\s+(?:\[([^\]]+)\]\s+(\S+)|(\S+)\s+\[([^\]]+)\])/.freeze
    RETURN = /@return\s+\[([^\]]+)\]/.freeze

    module_function

    def params(lines)
      result = {}
      lines.each do |text|
        m = PARAM.match(text)
        next unless m

        name = (m[2] || m[3]).delete_prefix("*").delete_prefix("*").delete_prefix("&").delete_suffix(":")
        result[name] ||= (m[1] || m[4]).strip
      end
      result
    end

    def returns(lines)
      lines.each do |text|
        m = RETURN.match(text)
        return m[1].strip if m
      end
      nil
    end
  end

  class Namespace
    attr_accessor :id, :name, :files, :types, :functions, :globals

    def initialize(id)
      @id = id
      @name = id == GLOBAL ? GLOBAL : id.split("::").last
      @files = []
      @types = []
      @functions = []
      @globals = []
    end
  end

  # One `class`, `module` or `X = Struct.new` in one file; a reopened class has several.
  class Decl
    attr_accessor :path, :kind, :node, :file, :nesting, :struct, :struct_fields, :extend_self, :instance_defs

    def initialize(path, kind, node, file, nesting)
      @path = path
      @kind = kind
      @node = node
      @file = file
      @nesting = nesting
      @struct = nil
      @struct_fields = []
      @extend_self = false
      @instance_defs = false
    end

    def body
      return node.body if %i[class_node module_node].include?(node.type)

      call = node.value
      Compat.block(call)&.body
    end
  end

  class TypeUnit
    attr_accessor :id, :name, :namespace, :decls, :place, :kind, :is_abstract, :members, :methods, :nested, :project_bases,
                  :external_bases, :superclass, :mixins, :extends, :record, :frozen, :outer, :parent, :parent_external

    def initialize(id, namespace)
      @id = id
      @name = id.split("::").last
      @namespace = namespace
      @decls = []
      @kind = "class"
      @is_abstract = false
      @members = []
      @methods = []
      @nested = []
      @project_bases = []
      @external_bases = []
      @superclass = nil
      @mixins = []
      @extends = []
      @record = false
      @frozen = false
      @outer = nil
      @parent = nil
      @parent_external = nil
    end

    def file
      decls.first.file
    end
  end

  class Fn
    attr_accessor :id, :name, :namespace, :place, :node, :kind, :visibility, :owner, :is_static, :is_abstract, :has_body,
                  :file, :nesting, :module_path

    def initialize(id, name, namespace, place, node, kind, visibility, owner, file, nesting)
      @id = id
      @name = name
      @namespace = namespace
      @place = place
      @node = node
      @kind = kind
      @visibility = visibility
      @owner = owner
      @is_static = false
      @is_abstract = false
      @has_body = true
      @file = file
      @nesting = nesting
      @module_path = nil
    end

    # The declared parameters: everything in the signature, the block parameter included.
    def parameter_nodes
      params = node.parameters
      return [] if params.nil?

      list = params.requireds + params.optionals
      list << params.rest if params.rest
      list += params.posts
      list += params.keywords
      list << params.keyword_rest if params.keyword_rest
      list << params.block if params.block
      list
    end

    def doc
      @doc ||= file.doc_above(node.location.start_line)
    end

    def doc_params
      @doc_params ||= Yard.params(doc)
    end

    def doc_return
      Yard.returns(doc)
    end

    def body_nodes
      return [] unless has_body && node.body

      [node.body]
    end

    def instance?
      owner && !is_static
    end
  end

  class Member
    attr_accessor :name, :kind, :node, :owner, :visibility, :is_static, :mutable, :value, :value_fn, :order, :file, :writer, :doc_type

    def initialize(name, kind, node, owner, visibility, is_static, mutable, order, file)
      @name = name
      @kind = kind
      @node = node
      @owner = owner
      @visibility = visibility
      @is_static = is_static
      @mutable = mutable
      @value = nil
      @value_fn = nil
      @order = order
      @file = file
      @writer = false
      @doc_type = nil
    end
  end

  Global = Struct.new(:id, :name, :place, :node, :namespace)

  module Glob
    module_function

    def regex(pattern)
      expression = Regexp.escape(pattern).gsub("\\*\\*/", "\0").gsub("\\*\\*", "\1").gsub("\\*", "[^/]*")
      Regexp.new("\\A#{expression.gsub("\0", "(.*/)?").gsub("\1", ".*")}\\z")
    end

    def any?(patterns, value)
      patterns.any? { |p| regex(p).match?(value) }
    end
  end

  # Tokens, comments and lines of code. A string or symbol with interpolations is one token, a heredoc too.
  module Scanner
    OPENERS = %i[STRING_BEGIN HEREDOC_START PERCENT_LOWER_W PERCENT_UPPER_W PERCENT_LOWER_I PERCENT_UPPER_I PERCENT_LOWER_X
                 REGEXP_BEGIN BACKTICK].to_set.freeze
    CLOSERS = %i[STRING_END HEREDOC_END REGEXP_END LABEL_END].to_set.freeze
    SKIPPED = %i[NEWLINE IGNORED_NEWLINE COMMENT EMBDOC_BEGIN EMBDOC_LINE EMBDOC_END __END__ EOF WORDS_SEP MISSING NOT_PROVIDED].to_set.freeze
    NAMES = %i[IDENTIFIER CONSTANT INSTANCE_VARIABLE CLASS_VARIABLE GLOBAL_VARIABLE METHOD_NAME LABEL BACK_REFERENCE NUMBERED_REFERENCE].to_set.freeze
    NUMBERS = %i[INTEGER FLOAT INTEGER_RATIONAL FLOAT_RATIONAL INTEGER_IMAGINARY FLOAT_IMAGINARY INTEGER_RATIONAL_IMAGINARY
                 FLOAT_RATIONAL_IMAGINARY].to_set.freeze

    module_function

    def scan(text, lexed)
      tokens = []
      code_lines = Set.new
      depth = 0
      start = nil
      pending_symbol = nil
      lexed.each do |token, _state|
        type = token.type
        line = token.location.start_line
        finish = token.location.end_line
        finish -= 1 if finish > line && token.value.end_with?("\n")
        if depth.positive?
          depth += 1 if OPENERS.include?(type) || (type == :SYMBOL_BEGIN && token.value != ":")
          if CLOSERS.include?(type)
            depth -= 1
            if depth.zero?
              tokens << Token.new(start.location.start_line, finish, "string", text.byteslice(start.location.start_offset...token.location.end_offset).to_s.chomp)
              (start.location.start_line..finish).each { |l| code_lines << l }
            end
          end
          next
        end
        if pending_symbol
          tokens << Token.new(pending_symbol.location.start_line, finish, "string", ":#{token.value}")
          code_lines << line
          pending_symbol = nil
          next
        end
        next if SKIPPED.include?(type)

        if OPENERS.include?(type) || (type == :SYMBOL_BEGIN && token.value != ":")
          start = token
          depth = 1
          next
        end
        if type == :SYMBOL_BEGIN
          pending_symbol = token
          next
        end
        kind = if type.to_s.start_with?("KEYWORD_") then "keyword"
               elsif NAMES.include?(type) then "name"
               elsif NUMBERS.include?(type) then "number"
               elsif %i[CHARACTER_LITERAL STRING_CONTENT].include?(type) then "string"
               else "op"
               end
        tokens << Token.new(line, finish, kind, token.value)
        (line..finish).each { |l| code_lines << l }
      end
      [tokens, code_lines.size]
    end
  end

  class Project
    attr_reader :root, :files, :namespaces, :types, :functions, :notes, :resolver, :decls, :by_namespace, :type_paths,
                :namespace_paths, :globals

    def initialize(root)
      @root = File.expand_path(root)
      @files = []
      @namespaces = []
      @by_namespace = {}
      @types = {}
      @functions = {}
      @notes = []
      @ids = Set.new
      @decls = []
      @globals = {}
      @resolver = nil
    end

    def relative(full)
      full.delete_prefix(@root).delete_prefix("/")
    end

    def load(include, exclude)
      found = []
      walk = lambda do |folder|
        entries = begin
          Dir.children(folder).sort
        rescue SystemCallError
          []
        end
        entries.each do |name|
          full = File.join(folder, name)
          if File.directory?(full)
            next if SKIPPED_FOLDERS.include?(name) || name.start_with?(".")

            walk.call(full)
          elsif name.end_with?(".rb") && File.file?(full)
            rel = relative(full)
            found << full if (include.empty? || Glob.any?(include, rel)) && !Glob.any?(exclude, rel)
          end
        end
      end
      walk.call(@root)
      found.sort_by! { |f| relative(f) }
      found.each_with_index { |full, i| add_file(full, i) }
      @files.each { |f| collect(f) }
      shape
      @files.each { |f| f.tree && declare_top(f) }
      @decls.each { |d| declare_body(d) }
      assign_files
      require_relative "resolve"
      @resolver = Resolver.new(self)
      @resolver.link
    end

    # Reading ------------------------------------------------------------------------------------------------------
    def read_source(full)
      text = File.binread(full).force_encoding("UTF-8")
      text = text.scrub("\uFFFD") unless text.valid_encoding?
      text = text.delete_prefix("\uFEFF")
      text.gsub("\r\n", "\n").tr("\r", "\n")
    end

    def add_file(full, index)
      rel = relative(full)
      text = read_source(full)
      lines = text.count("\n") + (!text.empty? && !text.end_with?("\n") ? 1 : 0)
      result = Prism.parse(text)
      lexed = Prism.lex(text).value
      tokens, loc = Scanner.scan(text, lexed)
      if (data = result.data_loc)
        loc = tokens.map(&:line).select { |l| l < data.start_line }.uniq.size
      end
      directives = Directives.new
      comment_lines = Set.new
      line_texts = text.split("\n", -1)
      comments = {}
      result.comments.each do |c|
        start = c.location.start_line
        finish = c.location.end_line
        finish -= 1 if finish > start && c.location.slice.end_with?("\n")
        directives.add(c.location.slice, start, finish)
        (start..finish).each { |l| comment_lines << l }
        comments[start] = c.location.slice if start == finish && line_texts[start - 1].to_s.lstrip.start_with?("#")
      end
      broken = !result.errors.empty?
      tree = broken ? nil : result.value
      import_lines = Set.new
      if tree
        Compat.walk(tree) do |n|
          next unless n.type == :call_node && n.receiver.nil? && %i[require require_relative load autoload].include?(n.name)

          (n.location.start_line..n.location.end_line).each { |l| import_lines << l }
        end
      end
      @files << SourceFile.new(path: rel, text: text, lines: lines, loc: loc, tokens: tokens, directives: directives,
                               import_lines: import_lines, tree: tree, broken: broken, line_texts: line_texts,
                               comment_lines: comment_lines, module: nil, index: index, comments: comments)
    end

    def unique_id(base)
      candidate = base
      n = 2
      while @ids.include?(candidate)
        candidate = "#{base}~#{n}"
        n += 1
      end
      @ids << candidate
      candidate
    end

    # Places: Prism columns are byte offsets, facts count characters.
    def column(file, line, offset)
      text = line.positive? && line <= file.line_texts.size ? file.line_texts[line - 1] : ""
      (text.byteslice(0, offset) || text).force_encoding("UTF-8").scrub.length + 1
    end

    def place(file, node)
      loc = node.respond_to?(:location) ? node.location : node
      end_line = loc.end_line
      end_column = loc.end_column
      if end_line > loc.start_line && end_column.zero?
        end_line -= 1
        end_column = (file.line_texts[end_line - 1] || "").bytesize
      end
      Place.new(file.path, loc.start_line, column(file, loc.start_line, loc.start_column), end_line, column(file, end_line, end_column))
    end

    # Declarations ---------------------------------------------------------------------------------------------------
    def path_of(constant, nesting)
      parts = Compat.constant_parts(constant)
      return nil if parts.nil?

      names, absolute = parts
      return names.join("::") if absolute || nesting.empty?

      "#{nesting.first}::#{names.join("::")}"
    end

    STRUCTS = { "Struct" => :struct, "Data" => :data }.freeze

    def struct_call(value)
      return nil unless value&.type == :call_node && value.receiver

      parts = Compat.constant_parts(value.receiver)
      return nil if parts.nil? || parts[0].size != 1

      kind = STRUCTS[parts[0][0]]
      return nil unless kind && ((kind == :struct && value.name == :new) || (kind == :data && value.name == :define))

      kind
    end

    # Every class and module declaration, with its lexical nesting (innermost first).
    def collect(file)
      return unless file.tree

      visit = lambda do |node, nesting|
        case node.type
        when :class_node, :module_node
          path = path_of(node.constant_path, nesting)
          if path
            d = Decl.new(path, node.type == :class_node ? :class : :module, node, file, [path] + nesting)
            @decls << d
            node.body && visit.call(node.body, d.nesting)
            node.superclass && visit.call(node.superclass, nesting) if node.type == :class_node
            next
          end
        when :constant_write_node
          kind = struct_call(node.value)
          if kind
            path = nesting.empty? ? node.name.to_s : "#{nesting.first}::#{node.name}"
            d = Decl.new(path, :class, node, file, [path] + nesting)
            d.struct = kind
            d.struct_fields = Compat.arguments(node.value).select { |a| a.type == :symbol_node }.map { |a| [a.unescaped.to_s, a] }
            @decls << d
            body = Compat.block(node.value)&.body
            body && visit.call(body, d.nesting)
            next
          end
        when :def_node
          next
        end
        node.compact_child_nodes.each { |c| visit.call(c, nesting) }
      end
      visit.call(file.tree, [])
    end

    # Items of a class or module body with the visibility section in force; nested classes, defs' bodies and blocks are
    # not entered. Yields [kind, node, info].
    def body_items(body, static: false, &blk)
      section = "public"
      module_function = false
      each_statement(body) do |n|
        if n.type == :call_node && n.receiver.nil? && %i[private public protected module_function].include?(n.name)
          args = Compat.arguments(n)
          if args.empty?
            if n.name == :module_function
              module_function = true
            else
              section = n.name.to_s
              module_function = false
            end
          else
            args.each do |a|
              if a.type == :def_node
                yield :def, a, { visibility: n.name == :module_function ? "public" : n.name.to_s, static: static || !a.receiver.nil?,
                                 module_function: n.name == :module_function }
              elsif %i[symbol_node string_node].include?(a.type)
                yield :visibility, a, { name: a.unescaped.to_s, visibility: n.name.to_s }
              elsif a.type == :call_node && %i[attr_reader attr_writer attr_accessor].include?(a.name)
                yield :attr, a, { visibility: n.name.to_s, static: static }
              end
            end
          end
          next
        end
        if n.type == :call_node && n.receiver.nil? && %i[private_class_method public_class_method].include?(n.name)
          Compat.arguments(n).each do |a|
            name = if a.type == :def_node then a.name.to_s
                   elsif %i[symbol_node string_node].include?(a.type) then a.unescaped.to_s
                   end
            yield :def, a, { visibility: n.name == :private_class_method ? "private" : "public", static: true, module_function: false } if a.type == :def_node
            yield :class_visibility, a, { name: name, visibility: n.name == :private_class_method ? "private" : "public" } if name
          end
          next
        end
        case n.type
        when :def_node
          yield :def, n, { visibility: n.receiver ? "public" : section, static: static || !n.receiver.nil?, module_function: module_function }
        when :singleton_class_node
          if n.expression.type == :self_node
            body_items(n.body, static: true, &blk)
          else
            yield :code, n, {}
          end
        when :call_node
          if n.receiver.nil? && %i[attr_reader attr_writer attr_accessor attr].include?(n.name)
            yield :attr, n, { visibility: section, static: static }
          elsif n.receiver.nil? && %i[include prepend extend].include?(n.name)
            yield :mixin, n, { static: static }
          else
            yield :code, n, {}
          end
        else
          yield :code, n, { static: static }
        end
      end
    end

    # Statements of a body, conditionals and begin blocks entered: their declarations still belong to the body.
    def each_statement(node, &blk)
      return if node.nil?

      case node.type
      when :statements_node
        node.body.each { |s| each_statement(s, &blk) }
      when :begin_node
        each_statement(node.statements, &blk)
        rescue_clause = node.rescue_clause
        while rescue_clause
          each_statement(rescue_clause.statements, &blk)
          rescue_clause = Compat.subsequent(rescue_clause)
        end
        each_statement(node.else_clause&.statements, &blk)
        each_statement(node.ensure_clause&.statements, &blk)
      when :if_node, :unless_node
        if Compat.ternary?(node)
          yield node
          return
        end
        yield node.predicate
        each_statement(node.statements, &blk)
        other = node.type == :if_node ? Compat.subsequent(node) : Compat.else_clause(node)
        if other
          other.type == :else_node ? each_statement(other.statements, &blk) : each_statement(other, &blk)
        end
      when :parentheses_node
        each_statement(node.body, &blk)
      else
        yield node
      end
    end

    # Which modules are mixins (types of kind trait) and which are namespaces.
    def shape
      @decls.each do |d|
        next unless d.kind == :module

        body_items(d.body) do |kind, node, info|
          d.instance_defs = true if kind == :def && !info[:static] && !info[:module_function]
          d.extend_self = true if kind == :mixin && node.name == :extend && Compat.arguments(node).any? { |a| a.type == :self_node }
        end
      end
      by_path = @decls.group_by(&:path)
      @extend_self = @decls.select(&:extend_self).map(&:path).to_set
      @type_paths = Set.new
      by_path.each do |path, list|
        if list.any? { |d| d.kind == :class }
          @type_paths << path
        elsif list.any?(&:instance_defs) && list.none?(&:extend_self)
          @type_paths << path
        end
      end
      @namespace_paths = Set.new
      by_path.each_key do |path|
        @namespace_paths << path unless @type_paths.include?(path)
        parts = path.split("::")
        (1...parts.size).each do |n|
          prefix = parts.first(n).join("::")
          @namespace_paths << prefix unless @type_paths.include?(prefix)
        end
      end
      by_path.keys.sort.each do |path|
        next unless @type_paths.include?(path)

        list = by_path[path].sort_by { |d| [d.file.index, d.node.location.start_offset] }
        t = TypeUnit.new(unique_id(path), namespace(namespace_of(path)))
        t.decls = list
        t.kind = list.any? { |d| d.kind == :class } ? "class" : "trait"
        t.is_abstract = t.kind == "trait"
        first = list.first
        t.place = place(first.file, first.node)
        struct = list.map(&:struct).compact.first
        if struct
          t.record = true
          t.frozen = struct == :data
        end
        @types[t.id] = t
        t.namespace.types << t
      end
      @types.each_value do |t|
        parts = t.id.split("::")
        next if parts.size < 2

        outer = @types[parts[0...-1].join("::")]
        if outer
          t.outer = outer
          outer.nested << t
        end
      end
    end

    # The namespace a type path lives in: the longest proper prefix that is not a type.
    def namespace_of(path)
      parts = path.split("::")
      (parts.size - 1).downto(1) do |n|
        prefix = parts.first(n).join("::")
        return prefix if @namespace_paths.include?(prefix)
      end
      GLOBAL
    end

    def namespace(id)
      @by_namespace[id] ||= begin
        ns = Namespace.new(id)
        @namespaces << ns
        ns
      end
    end

    def declare_top(file)
      visibility = {}
      body_items(file.tree.statements) do |kind, node, info|
        next unless kind == :def && node.receiver.nil?

        f = Fn.new(unique_id(node.name.to_s), node.name.to_s, namespace(GLOBAL), place(file, node), node, "function", "public", nil, file, [])
        add_function(f)
        visibility[f.name] = f
      end
      visibility
    end

    def declare_body(d)
      t = @types[d.path]
      overrides = {}
      class_overrides = {}
      defs = []
      body_items(d.body) do |kind, node, info|
        case kind
        when :def then defs << [node, info]
        when :visibility then overrides[info[:name]] = info[:visibility]
        when :class_visibility then class_overrides[info[:name]] = info[:visibility]
        when :attr then declare_attr(t, d, node, info) if t
        when :mixin
          if t
            (node.name == :extend ? t.extends : t.mixins) << [node, d]
          end
        when :code
          declare_constant(t, d, node) if t && node.type == :constant_write_node && struct_call(node.value).nil?
        end
      end
      if t
        d.struct_fields.each_with_index do |(name, node), i|
          next if t.members.any? { |m| m.name == name }

          m = Member.new(name, "property", node, t, "public", false, d.struct == :struct, [d.file.index, node.location.start_offset, i], d.file)
          m.writer = d.struct == :struct
          t.members << m
        end
      end
      defs.each do |node, info|
        name = node.name.to_s
        static = info[:static]
        if t
          visibility = static ? (class_overrides[name] || info[:visibility]) : (overrides[name] || info[:visibility])
          visibility = "public" if static && !class_overrides.key?(name) && node.receiver
          if info[:module_function]
            static = true
            visibility = "public"
          end
          kind = !static && name == "initialize" ? "constructor" : "method"
          visibility = "private" if kind == "constructor"
          id = static ? "#{t.id}.#{name}" : "#{t.id}##{name}"
          f = Fn.new(unique_id(id), name, t.namespace, place(d.file, node), node, kind, visibility, t, d.file, d.nesting)
          f.is_static = static
          add_function(f)
        else
          ns = namespace(d.path)
          next unless static || info[:module_function] || @extend_self.include?(d.path)

          f = Fn.new(unique_id("#{d.path}.#{name}"), name, ns, place(d.file, node), node, "function", "public", nil, d.file, d.nesting)
          f.module_path = d.path
          add_function(f)
        end
      end
    end

    def declare_attr(t, d, node, info)
      writer = %i[attr_writer attr_accessor].include?(node.name)
      Compat.arguments(node).each do |a|
        next unless %i[symbol_node string_node].include?(a.type)

        name = NomosRuby.utf8(a.unescaped)
        known = t.members.find { |m| m.name == name && m.is_static == info[:static] }
        if known
          known.writer ||= writer
          known.mutable ||= writer
          next
        end
        m = Member.new(name, "property", a, t, info[:visibility], info[:static], writer, [d.file.index, a.location.start_offset], d.file)
        m.writer = writer
        m.doc_type = Yard.returns(d.file.doc_above(node.location.start_line))
        t.members << m
      end
    end

    def declare_constant(t, d, node)
      name = node.name.to_s
      return if t.members.any? { |m| m.name == name }

      m = Member.new(name, "constant", node, t, "public", false, false, [d.file.index, node.location.start_offset], d.file)
      m.value = node.value
      t.members << m
    end

    def add_function(f)
      @functions[f.id] = f
      if f.owner
        f.owner.methods << f
      else
        f.namespace.functions << f
      end
    end

    # A file belongs to the deepest namespace that holds everything it declares.
    def assign_files
      by_file = Hash.new { |h, k| h[k] = [] }
      @types.each_value { |t| t.decls.each { |d| by_file[d.file] << t.namespace.id } }
      @functions.each_value { |f| by_file[f.file] << f.namespace.id unless f.owner }
      # A namespace body counts only when nothing is declared inside it in this file: `module A; class B` is B's file.
      enclosing = Hash.new { |h, k| h[k] = Set.new }
      @decls.each { |x| x.nesting.drop(1).each { |n| enclosing[x.file.object_id] << n } }
      @decls.each do |d|
        next unless d.kind == :module && @namespace_paths.include?(d.path)
        next if enclosing[d.file.object_id].include?(d.path)

        by_file[d.file] << d.path
      end
      @files.each do |file|
        ids = by_file[file]
        common = ids.empty? || ids.include?(GLOBAL) ? GLOBAL : ids.map { |i| i.split("::") }.reduce { |a, b| a.take_while.with_index { |x, i| b[i] == x } }.join("::")
        common = GLOBAL if common.empty?
        ns = namespace(common)
        ns.files << file
        file.module = ns
      end
      @namespaces.sort_by!(&:id)
    end

    def all_types
      @types.keys.sort.map { |k| @types[k] }
    end

    def all_functions
      @functions.keys.sort.map { |k| @functions[k] }
    end

    def modules
      @namespaces.select { |ns| !ns.files.empty? || !ns.types.empty? || !ns.functions.empty? || !ns.globals.empty? }
    end
  end
end
