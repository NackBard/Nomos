module Smell
  module Report
    class God
      # @param order [Data::Order]
      def one(order)
        return a if order.price > 0

        0
      end

      # @param order [Data::Order]
      def two(order)
        return b if order.tax > 0

        0
      end

      # @param order [Data::Order]
      def three(order)
        return c if order.fee > 0

        0
      end

      # @param order [Data::Order]
      def four(order)
        return d if order.price > 0

        0
      end

      private

      attr_reader :a, :b, :c, :d
    end
  end
end
