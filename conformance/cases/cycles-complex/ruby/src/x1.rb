module Cx
  module Left
    class X1
      def following = X2
    end

    class X2
      def back = X1
      def bridge = Right::Y1
    end
  end
end
