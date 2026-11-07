module Shapes
  module Shape
    def area
      raise NotImplementedError
    end
  end

  class ShapeBase
    attr_accessor :id
  end

  class Square < ShapeBase
    attr_accessor :side
  end
end
