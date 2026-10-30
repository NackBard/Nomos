namespace F;
public class C
{
    public const string Query = "SELECT * FROM users WHERE name = @name";
    public string Greet(string name) => "Hello " + name;
}
