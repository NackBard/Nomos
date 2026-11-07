module Cyc
  module D
    class D1
      def peer = D2
      def entry = A::A1
    end

    class D2
      def peer = D1
    end
  end
end
