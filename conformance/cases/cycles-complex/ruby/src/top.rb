module Cx
  module Dag
    class Top
      def m1 = Mid1
      def m2 = Mid2
    end

    class Mid1
      def finish = Bottom
    end

    class Mid2
      def finish = Bottom
    end

    class Bottom
    end

    class Self
      def following = Self
    end
  end
end
