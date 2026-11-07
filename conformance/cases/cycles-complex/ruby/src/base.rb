module Cx
  module Mixed
    class Base
      def make
        Derived.new
      end
    end

    class Derived < Base
    end
  end
end
