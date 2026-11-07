module Cx
  module Ring
    class N1
      def following = N2
    end

    class N2
      def following = N3
      def skip = N4
    end

    class N3
      def following = N4
    end

    class N4
      def following = N5
    end

    class N5
      def following = N1
    end
  end
end
