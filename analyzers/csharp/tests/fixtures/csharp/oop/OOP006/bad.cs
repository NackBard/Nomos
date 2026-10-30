namespace F;
public class Base
{
    public void One() { }
    public void Two() { }
}
public class Unrelated : Base // expect
{
    public int Own() => 1;
}
