module Blast
  module Diamond
    class Bottom
      def size
        1
      end
    end

    class Left < Bottom
    end

    class Right
      def shared
        @shared ||= Bottom.new
      end
    end

    class Top
      def parts
        [Left.new, Right.new]
      end
    end
  end
end
