namespace Cx.Ring;

public class N1
{
    public N2 Next;
}

public class N2
{
    public N3 Next;
    public N4 Skip;
}

public class N3
{
    public N4 Next;
}

public class N4
{
    public N5 Next;
}

public class N5
{
    public N1 Next;
}
