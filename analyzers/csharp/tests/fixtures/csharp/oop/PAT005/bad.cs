namespace F;
public interface IStore { int Get(); }
public class Db : IStore { public int Get() => 1; }
public class Cached : IStore // expect
{
    private readonly IStore _inner;
    public Cached(IStore inner) { _inner = inner; }
    public int Get() => _inner.Get();
}
