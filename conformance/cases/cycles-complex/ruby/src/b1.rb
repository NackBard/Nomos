module Cx
  module B
    class B1
    end

    class B2
      def back = A::A2
    end

    class B3
      def out = C::C1
    end
  end
end
