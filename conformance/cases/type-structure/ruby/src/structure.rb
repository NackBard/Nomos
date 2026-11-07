module Ts
  module Shape
    # @return [Float]
    def area
      raise NotImplementedError
    end
  end

  class Base
    include Shape

    # @return [String]
    attr_reader :name

    def initialize(name)
      @name = name
    end
  end

  class Square < Base
    SIDES = 4
    @@created = 0

    # @return [Scale]
    attr_accessor :unit

    class << self
      attr_accessor :default_side
    end

    # @param side [Float]
    def initialize(side)
      super("square")
      @side = side
      @cells = []
      @@created += 1
    end

    # @return [Float]
    def area
      @side * @side
    end

    # @return [Square]
    def self.unit_square
      new(1.0)
    end
  end

  class Scale
    MM = 1
    CM = 10
  end

  class Drawing
    def initialize
      @items = []
      @frame = Square.new(2.0)
    end

    # @param item [Object]
    # @param tags [String]
    def add(item, *tags, at: 0, **options, &block)
      @items << item
    end
  end

  class Painter
    # @param square [Square]
    # @return [Float]
    def paint(square)
      square.area
    end
  end

  Point = Struct.new(:x, :y)
end
