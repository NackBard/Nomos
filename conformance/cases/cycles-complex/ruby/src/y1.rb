module Cx
  module Right
    class Y1
      def following = Y2
    end

    class Y2
      def back = Y1
    end
  end
end
