namespace F;
public interface IRepo { }
public class SqlRepo : IRepo { }
public class Service(IRepo repo)
{
    public object Run() => repo;
}
public class RepoFactory { public IRepo Create() => new SqlRepo(); }
public class SqlRepoTests
{
    [Fact]
    public void Creates() { var repo = new SqlRepo(); }
}
public sealed class FactAttribute : System.Attribute { }
