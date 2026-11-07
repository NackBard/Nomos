def reported(a)
  n = 0
  a.each do |x|
    a.each do |y|
      n += x * y
    end
  end
  n
end

# nomos-disable-next-line ALG001
def next_line(a)
  n = 0
  a.each do |x|
    a.each do |y|
      n += x * y
    end
  end
  n
end

def same(a) # nomos-disable-line ALG001
  n = 0
  a.each do |x|
    a.each do |y|
      n += x * y
    end
  end
  n
end

# nomos-disable-next-line CC001
def other_rule(a)
  n = 0
  a.each do |x|
    a.each do |y|
      n += x * y
    end
  end
  n
end

def reasoned(a) # nomos-disable-line alg001, CC003 -- input is bounded
  n = 0
  a.each do |x|
    a.each do |y|
      n += x * y
    end
  end
  n
end
