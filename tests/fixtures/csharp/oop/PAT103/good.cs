namespace F;
public class Engine { public int A() => 1; public int B() => 2; }
public class Car
{
    private readonly Engine _e = new();
    public int A() => _e.A() + 1;
    public int B() => _e.B() * 2;
    public int Wheels() => 4;
}
