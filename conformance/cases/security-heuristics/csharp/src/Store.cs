namespace Sec.Code;

public class Store
{
    private string _password = "hunter22";
    private string _title = "hunter22";
    private string _awsKey = "AKIAABCDEFGHIJKLMNOP";

    public string Query(string name)
    {
        return "SELECT id FROM users WHERE name = '" + name + "'";
    }

    public string Fixed()
    {
        return "SELECT id FROM users";
    }

    public string Interpolated(string id)
    {
        return $"DELETE FROM users WHERE id = {id}";
    }

    public object Danger()
    {
        return new System.Runtime.Serialization.Formatters.Binary.BinaryFormatter();
    }
}
