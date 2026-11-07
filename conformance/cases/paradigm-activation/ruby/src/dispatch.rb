module Dispatch
  class A
    attr_accessor :tag
  end

  class B
  end

  class C
  end

  def self.route(x)
    return 1 if x.is_a?(A)
    return 2 if x.is_a?(B)
    return 3 if x.is_a?(C)

    0
  end
end
