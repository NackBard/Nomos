package sec.code;

public class Store {
    private String password = "hunter22";
    private String title = "hunter22";
    private String awsKey = "AKIAABCDEFGHIJKLMNOP";

    public String query(String name) {
        return "SELECT id FROM users WHERE name = '" + name + "'";
    }

    public String fixed() {
        return "SELECT id FROM users";
    }

    public String formatted(String id) {
        return "DELETE FROM users WHERE id = %s".formatted(id);
    }

    public String format(String id) {
        return String.format("UPDATE users SET name = 'x' WHERE id = %s", id);
    }
}
