module Blast
  module Ring
    class R1
      def following
        @following ||= R2.new
      end
    end

    class R2
      def following
        @following ||= R3.new
      end
    end

    class R3
      def following
        @following ||= R1.new
      end

      def finish
        @finish ||= Leaf.new
      end
    end

    class Tail
      def head
        @head ||= R1.new
      end
    end

    class Leaf
      def last
        @last ||= Chain::C4.new
      end
    end
  end
end
