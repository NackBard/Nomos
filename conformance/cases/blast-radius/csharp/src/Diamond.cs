namespace Blast.Diamond;

public class Bottom
{
    public int Size()
    {
        return 1;
    }
}

public class Left : Bottom
{
}

public class Right
{
    public Bottom Shared;
}

public class Top
{
    public Left L;
    public Right R;
}
