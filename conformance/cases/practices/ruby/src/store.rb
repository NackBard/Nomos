module Store
  PASSWORD = "hunter22"

  def self.find(name)
    "SELECT id FROM items WHERE name = '" + name + "'"
  end

  def self.total(a, b, c, d, e, f)
    a + b + c + d + e + f
  end
end
