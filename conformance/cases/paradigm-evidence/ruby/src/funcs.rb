module Funcs
  $counter = 0

  def self.add(a, b)
    a + b
  end

  def self.bump
    $counter += 1
  end
end
