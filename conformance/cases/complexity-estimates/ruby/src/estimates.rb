module Alg
  module Code
    class Estimates
      def constant(a)
        a + 1
      end

      def linear(items)
        n = 0
        items.each do |x|
          n += x
        end
        n
      end

      def quadratic(a, b)
        n = 0
        a.each do |x|
          b.each do |y|
            n += x * y
          end
        end
        n
      end

      def halving(size)
        steps = 0
        i = size
        while i > 0
          i /= 2
          steps += 1
        end
        steps
      end

      def linear_log(items)
        n = 0
        items.each do |x|
          n += halving(x)
        end
        n
      end

      def fixed
        n = 0
        10.times do |i|
          n += i
        end
        n
      end

      def fib(n)
        return n if n < 2

        fib(n - 1) + fib(n - 2)
      end

      def factorial(n)
        return 1 if n < 2

        n * factorial(n - 1)
      end

      def search(items, low, high)
        return low if low >= high

        mid = (low + high) / 2
        return search(items, low, mid) if items[mid] > 0

        search(items, mid, high)
      end

      def cubic_via_callee(items)
        n = 0
        items.each do |x|
          n += quadratic(items, items)
        end
        n
      end
    end
  end
end
