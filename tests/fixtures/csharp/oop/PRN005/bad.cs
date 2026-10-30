namespace F;
public interface IRepo { }
public class SqlRepo : IRepo { }
public class Service
{
    public object Run()
    {
        var repo = new SqlRepo(); // expect
        return repo;
    }
}
