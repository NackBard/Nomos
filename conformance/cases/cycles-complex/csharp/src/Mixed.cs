namespace Cx.Mixed;

public class Base
{
    public object Make()
    {
        return new Derived();
    }
}

public class Derived : Base
{
}
