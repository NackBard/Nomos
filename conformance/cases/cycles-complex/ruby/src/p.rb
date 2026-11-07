module Cx
  module Eight
    class P
      def following = Q
    end

    class Q
      def back = P
      def side = S
    end

    class S
      def back = Q
    end
  end
end
