namespace Blast.Ring;

public class R1
{
    public R2 Next;
}

public class R2
{
    public R3 Next;
}

public class R3
{
    public R1 Next;
    public Leaf End;
}

public class Tail
{
    public R1 Head;
}

public class Leaf
{
    public Blast.Chain.C4 Last;
}
