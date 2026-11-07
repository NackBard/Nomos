module Blast
  module Chain
    class C1
    end

    class C2
      def prev
        @prev ||= C1.new
      end
    end

    class C3
      def prev
        @prev ||= C2.new
      end
    end

    class C4
      def prev
        @prev ||= C3.new
      end
    end
  end
end
