namespace F;
public class Base
{
    public virtual int One() => 1;
    public int Two() => 2;
}
public class Child : Base
{
    public override int One() => Two();
}
