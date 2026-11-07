module Alg
  module Code
    class Memory
      def none(a)
        a
      end

      def grows(items)
        list = []
        items.each do |x|
          list << x
        end
        list
      end

      def grid(a, b)
        list = []
        a.each do |x|
          b.each do |y|
            list << x + y
          end
        end
        list.size
      end

      def sized(n)
        Array.new(n)
      end

      def constant
        Array.new(8)
      end

      def deep(n)
        return 0 if n < 1

        deep(n - 1)
      end

      def new_in_nested(a, b)
        n = 0
        a.each do |x|
          b.each do |y|
            n += Box.new.size + x + y
          end
        end
        n
      end

      def new_in_loop(a)
        n = 0
        a.each do |x|
          n += Box.new.size + x
        end
        n
      end
    end

    class Box
      attr_accessor :size
    end
  end
end
