module Metrics
  class Basics
    def self.straight(a)
      a + 1
    end

    # A comment line inside the type: it counts toward lines but not toward loc.
    def self.branches(a, b)
      if a > 0 && b > 0
        return 1
      elsif a < 0 || b < 0
        return -1
      end

      0
    end

    def self.loops(items, limit)
      total = 0
      items.each do |item|
        limit.times do |i|
          if item > i
            total += item
          end
        end
      end

      total
    end

    def self.switches(kind, text)
      begin
        case kind
        when 1 then return "one"
        when 2 then return "two"
        else return text
        end
      rescue ArgumentError
        return kind > 0 ? "error" : "unknown"
      end
    end
  end
end
