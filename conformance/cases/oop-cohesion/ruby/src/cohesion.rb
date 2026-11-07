module Cohesion
  Data = ::Data.define(:value, :other)

  class Mixed
    # @return [Data]
    attr_reader :source

    def inc_a
      @a = @a.to_i + 1
    end

    def read_a
      @a.to_i
    end

    def inc_b
      @b = @b.to_i + 1
    end

    def peek
      source.value + source.other
    end
  end

  class Derived < Mixed
  end
end
