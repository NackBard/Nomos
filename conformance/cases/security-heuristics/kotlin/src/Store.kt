package sec.code

class Store {
    private val password = "hunter22"
    private val title = "hunter22"
    private val awsKey = "AKIAABCDEFGHIJKLMNOP"

    fun query(name: String): String {
        return "SELECT id FROM users WHERE name = '$name'"
    }

    fun fixed(): String {
        return "SELECT id FROM users"
    }

    fun formatted(id: String): String {
        return "DELETE FROM users WHERE id = %s".format(id)
    }

    fun format(id: String): String {
        return String.format("UPDATE users SET name = 'x' WHERE id = %s", id)
    }
}
