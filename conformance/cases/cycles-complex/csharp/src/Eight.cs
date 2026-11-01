namespace Cx.Eight;

public class P
{
    public Q Next;
}

public class Q
{
    public P Back;
    public S Side;
}

public class S
{
    public Q Return;
}
