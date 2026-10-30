namespace F;
public class Engine { public int A() => 1; public int B() => 2; public int C() => 3; }
public class Car // expect
{
    private readonly Engine _e = new();
    public int A() => _e.A();
    public int B() => _e.B();
    public int C() => _e.C();
}
