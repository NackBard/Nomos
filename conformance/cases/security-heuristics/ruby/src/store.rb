module Store
  PASSWORD = "hunter22"
  TITLE = "hunter22"
  AWS_KEY = "AKIAABCDEFGHIJKLMNOP"

  def self.query(name)
    "SELECT id FROM users WHERE name = '" + name + "'"
  end

  def self.fixed
    "SELECT id FROM users"
  end

  def self.formatted(user_id)
    "DELETE FROM users WHERE id = #{user_id}"
  end
end
