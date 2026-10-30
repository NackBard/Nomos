namespace F;
public class C
{
    public string Find(string name) => "SELECT * FROM users WHERE name = '" + name + "'"; // expect
    public string Drop(string t) => $"DROP TABLE {t}"; // expect
}
