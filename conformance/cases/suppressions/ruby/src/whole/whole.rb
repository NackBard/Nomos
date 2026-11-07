# nomos-disable ALG001
def pairs(a)
  n = 0
  a.each do |x|
    a.each do |y|
      n += x * y
    end
  end
  n
end
