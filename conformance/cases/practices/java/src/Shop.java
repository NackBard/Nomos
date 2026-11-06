package prac.code;

public class Shop {
    private String password = "hunter22";

    public String find(String name) {
        return "SELECT id FROM items WHERE name = '" + name + "'";
    }

    public int sum(int a, int b, int c, int d, int e, int f) {
        return a + b + c + d + e + f;
    }
}
