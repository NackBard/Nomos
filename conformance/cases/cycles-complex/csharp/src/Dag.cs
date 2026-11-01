namespace Cx.Dag;

public class Top
{
    public Mid1 M1;
    public Mid2 M2;
}

public class Mid1
{
    public Bottom End;
}

public class Mid2
{
    public Bottom End;
}

public class Bottom
{
}

public class Self
{
    public Self Next;
}
