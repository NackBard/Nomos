module Lambdas
  def self.scan(xs)
    xs.any? { |x| xs.any? { |y| y == x } }
  end
end
