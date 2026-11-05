namespace Prac.Code;

public class Shop
{
    private string _password = "hunter22";

    public string Find(string name)
    {
        return "SELECT id FROM items WHERE name = '" + name + "'";
    }

    public int Sum(int a, int b, int c, int d, int e, int f)
    {
        return a + b + c + d + e + f;
    }
}
