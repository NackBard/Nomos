namespace Pat.Code;

public class Logged : IShape
{
    private readonly IShape _inner;

    public Logged(IShape inner)
    {
        _inner = inner;
    }

    public int Area() => _inner.Area();
}
