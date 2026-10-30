namespace F;
public class Bird { public virtual int Speed() => 1; }
public class Falcon : Bird
{
    public override int Speed() => 90;
}
