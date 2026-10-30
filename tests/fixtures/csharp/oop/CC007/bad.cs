namespace F;
public class C
{
    private int _unused; // expect
    private void Forgotten() { } // expect
    public int Go()
    {
        var never = 1; // expect
        return 2;
        Console.WriteLine("x"); // expect
    }
}
