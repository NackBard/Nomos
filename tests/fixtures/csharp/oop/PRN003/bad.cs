namespace F;
public class Bird { public virtual void Fly() { } }
public class Penguin : Bird
{
    public override void Fly() => throw new NotSupportedException(); // expect
}
