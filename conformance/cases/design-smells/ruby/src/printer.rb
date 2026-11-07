module Smell
  module Report
    class Printer
      def initialize
        @copies = 1
        @width = 0
        @depth = 0
      end

      # @param order [Data::Order]
      def envy(order)
        order.price + order.tax + order.fee
      end

      # @param order [Data::Order]
      def balanced(order)
        order.price + order.tax + order.fee + @copies + @width + @depth
      end

      # @param order [Data::Order]
      def few(order)
        order.price + order.tax
      end

      # @param money [Data::Money]
      def reads_money(money)
        money.amount + money.cents + money.rate
      end

      # @param order [Data::Order]
      def self.sum(order)
        order.price + order.tax + order.fee
      end
    end
  end
end
