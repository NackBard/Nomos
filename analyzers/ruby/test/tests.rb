# frozen_string_literal: true

# Tests of the Ruby analyzer (D-061): `ruby --disable-gems test/tests.rb`. A small runner of its own, as in the Java
# and Kotlin analyzers: minitest is a bundled gem, and the analyzer runs without gems.
require "json"
require "open3"
require "prism"
require "tmpdir"
require "fileutils"

HERE = __dir__
MAIN = File.join(HERE, "..", "main.rb")
$LOAD_PATH.unshift(File.join(HERE, "..", "lib"))
require "nomos_ruby/text"
require "nomos_ruby/config"
require "nomos_ruby/project"

module Check
  class Failure < StandardError; end

  def self.equal(expected, actual, what = "")
    raise Failure, "#{what}\n  expected: #{expected.inspect}\n  actual:   #{actual.inspect}" unless expected == actual
  end

  def self.truthy(value, what)
    raise Failure, what unless value
  end
end

# Writes the files into a temporary folder, runs `analyze` in a separate Ruby and returns the exit code, facts, stderr.
def run(files, *args)
  Dir.mktmpdir do |root|
    files.each do |name, text|
      path = File.join(root, name)
      FileUtils.mkdir_p(File.dirname(path))
      File.binwrite(path, text)
    end
    out, err, status = Open3.capture3(RbConfig.ruby, "--disable-gems", MAIN, "analyze", "--root", root, *args, chdir: root)
    [status.exitstatus, out.empty? ? nil : JSON.parse(out), err, out]
  end
end

def by_id(items)
  items.to_h { |x| [x["id"], x] }
end

def edges(facts)
  facts["dependencies"].reject { |d| d["external"] }.map { |d| [d["from"], d["to"], d["kind"]] }.sort
end

# Detectors are methods named after their rule; a helper outside them reports for one rule.
HELPERS = { "check_secret" => "SEC001" }.freeze

def source_templates
  found = []
  Dir[File.join(HERE, "..", "lib", "nomos_ruby", "*.rb")].sort.each do |path|
    next if File.basename(path) == "text.rb"

    tree = Prism.parse(File.read(path, encoding: "UTF-8")).value
    visit = lambda do |node, rule|
      if node.type == :def_node
        name = node.name.to_s
        rule = name.upcase if name.match?(/\A[a-z]{2,4}\d{3}\z/)
        rule = HELPERS[name] if HELPERS.key?(name)
      end
      if node.type == :call_node && node.name == :tx && node.receiver.nil?
        first = node.arguments&.arguments&.first
        literal = first&.type == :string_node ? first.unescaped : nil
        found << [rule, literal, "#{File.basename(path)}:#{node.location.start_line}"]
      end
      node.compact_child_nodes.each { |c| visit.call(c, rule) }
    end
    visit.call(tree, "")
  end
  found
end

TESTS = {}

def test(name, &blk)
  TESTS[name] = blk
end

test "a text keeps its template and renders the arguments" do
  text = NomosRuby::Texts.tx("{0} has {1}% coverage, D = {2}, {{3}}", "a.rb", 42, NomosRuby::Texts.fixed(0.5, 2))
  Check.equal("{0} has {1}% coverage, D = {2}, {{3}}", text.template)
  Check.equal(["a.rb", "42", "0.50"], text.args)
  Check.equal("a.rb has 42% coverage, D = 0.50, {3}", NomosRuby::Texts.render(text))
  raised = begin
    NomosRuby::Texts.tx("{0}", 0.5)
    false
  rescue TypeError
    true
  end
  Check.truthy(raised, "a fractional argument must be formatted by the caller")
  Check.equal("0.13", NomosRuby::Texts.fixed(0.125, 2))
  Check.equal("3", NomosRuby::Texts.fixed(2.5, 0))
end

test "every text of a finding is a template of its rule" do
  spec = NomosRuby.spec_rules.to_h { |r| [r["id"], (r["messages"] || {}).values.map { |m| m["text"] }] }
  found = source_templates
  Check.truthy(found.size > 50, "only #{found.size} texts found: the scan is broken")
  problems = found.filter_map do |rule, template, where|
    if template.nil? then "#{where}: the template is not a literal"
    elsif rule.empty? then "#{where}: tx outside a detector"
    elsif !spec.fetch(rule, []).include?(template) then "#{where} #{rule}: not in spec: #{template}"
    end
  end
  Check.equal([], problems)
end

test "manifest lists the supported rules with the texts of spec" do
  out, _, status = Open3.capture3(RbConfig.ruby, "--disable-gems", MAIN, "manifest")
  Check.equal(0, status.exitstatus)
  manifest = JSON.parse(out)
  Check.equal("ruby", manifest["language"])
  Check.equal(["**/*.rb"], manifest["files"])
  Check.equal(false, manifest["capabilities"]["semantic"])
  Check.truthy(!manifest["capabilities"]["supportedRules"].include?("OOP001"), "OOP001 is not supported: no public fields")
end

test "elsif stays on the level of its if, else with an if inside nests" do
  _, facts = run("flow.rb" => <<~RUBY)
    def chain(x)
      if x > 2
        1
      elsif x > 1
        2
      elsif x > 0
        3
      end
    end

    def nested(x)
      if x > 2
        1
      else
        if x > 1
          2
        end
      end
    end
  RUBY
  functions = by_id(facts["functions"])
  Check.equal(1, functions["chain"]["metrics"]["maxNesting"], "elsif")
  Check.equal(4, functions["chain"]["metrics"]["cyclomatic"], "elsif decisions")
  Check.equal(2, functions["nested"]["metrics"]["maxNesting"], "else if")
end

test "include and prepend inherit, extend refers, a compact path names the namespace" do
  _, facts = run("shop.rb" => <<~RUBY)
    module Shop
      module Priced
        def price = 1
      end

      module Tracked
        def track = nil
      end

      module Builder
        def build = new
      end
    end

    # The compact form does not nest in Shop: its constants are found by the full path, as Ruby finds them.
    class Shop::Cart
      include Shop::Priced
      prepend Shop::Tracked
      extend Shop::Builder
    end
  RUBY
  Check.equal([["Shop::Cart", "Shop::Builder", "type-ref"], ["Shop::Cart", "Shop::Priced", "inheritance"], ["Shop::Cart", "Shop::Tracked", "inheritance"]],
              edges(facts))
  types = by_id(facts["types"])
  Check.equal("Shop", types["Shop::Cart"]["module"])
  Check.equal(%w[trait trait trait], %w[Shop::Priced Shop::Tracked Shop::Builder].map { |id| types[id]["kind"] })
  Check.equal(0, types["Shop::Cart"]["metrics"]["dit"], "a mixin is not a step of DIT")
end

test "a class reopened in two files is one type with the members of both" do
  _, facts = run("a.rb" => "class Box\n  attr_reader :width\nend\n", "b.rb" => "class Box\n  def area = width * 2\nend\n")
  types = by_id(facts["types"])
  Check.equal(["Box"], types.keys)
  Check.equal("a.rb", types["Box"]["location"]["file"])
  Check.equal(2, types["Box"]["metrics"]["memberCount"])
  Check.equal(["Box#area"], facts["functions"].map { |f| f["id"] })
end

test "module functions and singleton methods of a namespace are free functions" do
  _, facts = run("util.rb" => <<~RUBY)
    module Util
      module_function

      def slug(text) = text.downcase
    end

    module Clock
      def self.now = 0
    end

    module Strings
      extend self

      def blank?(text) = text.empty?
    end
  RUBY
  Check.equal([], facts["types"].map { |t| t["id"] }, "no mixin among them")
  functions = by_id(facts["functions"])
  Check.equal(%w[Clock.now Strings.blank? Util.slug], functions.keys.sort)
  Check.equal("function", functions["Util.slug"]["kind"])
  Check.equal("Clock", functions["Clock.now"]["module"])
end

test "types from YARD give a receiver its type, never an edge of their own" do
  _, facts = run("report.rb" => <<~RUBY)
    class Order
      attr_reader :price
    end

    class Report
      # @param order [Order]
      # @return [Integer]
      def total(order)
        order.price
      end

      # @param other [Order]
      def ignore(other)
        1
      end
    end
  RUBY
  Check.equal([["Report", "Order", "type-ref"]], edges(facts))
  total = by_id(facts["functions"])["Report#total"]
  Check.equal([{ "name" => "order", "typeName" => "Order" }], total["parameters"])
  Check.equal("Integer", total["returnTypeName"])
end

test "a string with interpolation and a heredoc are one token each" do
  _, facts = run("text.rb" => "def a(x)\n  \"a \#{x} b \#{x + 1}\"\nend\n\ndef b(x)\n  <<~T\n    a \#{x}\n  T\nend\n")
  functions = by_id(facts["functions"])
  Check.equal(%w[a b], functions.keys.sort)
  # def a x "…": four distinct tokens, the separators ( ) and end aside; a heredoc spans its lines as one token.
  Check.equal(8, functions["a"]["metrics"]["halsteadVolume"])
  Check.equal(8, facts["files"][0]["loc"], "nine lines, one blank")
end

test "global variables and class variables written in methods are shared state" do
  _, facts = run("state.rb" => <<~RUBY)
    module Cache
      $hits = 0

      class Store
        @@size = 0
        LIMIT = 4

        def grow
          @@size += 1
        end
      end
    end
  RUBY
  evidence = facts["modules"].find { |m| m["id"] == "Cache" }["paradigmEvidence"].find { |e| e["kind"] == "str.global-state" }
  Check.equal(["$hits", "Cache::Store.@@size"], evidence["examples"])
end

test "practices switch rules off with the shared message" do
  _, facts = run({ "a.rb" => "def f(a) = a\n", "nomos.json" => JSON.generate({ schemaVersion: "1.1.0", practices: ["security"] }) }, "--config", "nomos.json")
  skipped = facts["skippedRules"].find { |s| s["ruleId"] == "CC003" }
  Check.equal("disabled-by-config", skipped["reason"])
  Check.truthy(skipped["message"].include?("'practices' in nomos.json"), skipped["message"])
end

test "exit codes" do
  Check.equal(2, run({ "a.rb" => "" }, "--unknown", "x")[0], "unknown option")
  Check.equal(3, run({ "a.rb" => "" }, "--config", "missing.json")[0], "missing config")
  Check.equal(2, run({ "a.rb" => "" }, "--rules", "NOPE1")[0], "unknown rule")
  code, facts = run("broken.rb" => "def (\n", "good.rb" => "class Ok\nend\n")
  Check.equal(4, code, "a broken file")
  Check.equal(false, facts["files"].find { |f| f["path"] == "broken.rb" }["parsed"])
  out, _, status = Open3.capture3(RbConfig.ruby, "--disable-gems", MAIN, "analyze", "--root", File.join(HERE, "no-such-folder"))
  Check.equal(3, status.exitstatus, "missing root")
  Check.equal("", out)
end

test "an empty folder is an empty analysis" do
  code, facts = run({})
  Check.equal(0, code)
  Check.equal([], facts["files"])
  Check.equal(["no-files"], facts["diagnostics"].map { |d| d["code"] })
end

test "a file in another encoding does not stop the analysis" do
  code, facts = run("legacy.rb" => "# encoding: us-ascii\nmodule Legacy\n  PASSWORD = \"p\\xE4ssw0rd!\"\nend\n".b)
  Check.equal(0, code)
  Check.equal(["Legacy"], facts["modules"].map { |m| m["id"] })
end

test "output is deterministic" do
  files = { "a.rb" => "module A\n  class B\n    def c(x) = x.each { |y| y }\n  end\nend\n", "b.rb" => "class D < A::B\nend\n" }
  Check.equal(run(files)[3], run(files)[3])
end

test "the clone search with its cache finds what the plain search finds" do
  require "nomos_ruby/facts"
  row = "  ROW = [1, 2, 3, 4]
"
  files = { "a.rb" => "TABLE = [
#{row * 40}]
", "b.rb" => "OTHER = [
#{row * 12}]
def f(x) = x
#{row * 30}" }
  Dir.mktmpdir do |root|
    files.each { |name, text| File.write(File.join(root, name), text) }
    p = NomosRuby::Project.new(root)
    p.load([], [])
    window = 20
    run = NomosRuby::Run.new(p, NomosRuby::Config.new({ "rules" => { "MNT003" => { "threshold" => { "minTokens" => window } } } }), [], nil, {})
    run.rule = NomosRuby.spec_rules.find { |r| r["id"] == "MNT003" }
    NomosRuby::Detectors.mnt003(run)
    fast = run.findings.map { |f| [f.place.file, f.place.start_line, f.message] }
    # The search without the cache: every earlier place with the same hash compared in full.
    ids = {}
    sources = p.files.map { |f| [f, NomosRuby::Detectors.normalized(f, ids)] }.select { |x| x[1].size >= window }
    plain = []
    seen = Hash.new { |h, k| h[k] = [] }
    sources.each_with_index do |(file, tokens), index|
      skip_until = 0
      (0..(tokens.size - window)).each do |at|
        key = tokens[at, window].map(&:first)
        if at >= skip_until
          seen.fetch(key, []).each do |earlier, from|
            other = sources[earlier][1]
            length = 0
            length += 1 while from + length < other.size && at + length < tokens.size && other[from + length][0] == tokens[at + length][0]
            next if length < window || (earlier == index && from + length > at)

            skip_until = at + length
            plain << [file.path, tokens[at][1], "#{length} tokens duplicate #{sources[earlier][0].path}:#{other[from][1]}"]
            break
          end
        end
        seen[key] << [index, at]
      end
    end
    Check.truthy(!plain.empty?, "the table repeats, so there are clones")
    Check.equal(plain.sort, fast.sort)
  end
end

failures = 0
TESTS.each do |name, blk|
  blk.call
  puts "PASS  #{name}"
rescue Check::Failure, StandardError => e
  failures += 1
  puts "FAIL  #{name}\n  #{e.message}"
end
puts "\n#{TESTS.size - failures} passed, #{failures} failed"
exit(failures.zero? ? 0 : 1)
