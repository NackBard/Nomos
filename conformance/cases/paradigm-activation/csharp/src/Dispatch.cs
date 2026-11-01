namespace Pa.Dispatch;

public class A
{
}

public class B
{
}

public class C
{
}

public class Router
{
    public static int Route(object x)
    {
        if (x is A)
        {
            return 1;
        }

        if (x is B)
        {
            return 2;
        }

        if (x is C)
        {
            return 3;
        }

        return 0;
    }
}
