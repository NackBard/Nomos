module Hof
  def self.twice(f, x)
    f.call(f.call(x))
  end
end
