namespace F;
public class C
{
    public void Go()
    {
        try { Console.WriteLine(); }
        catch (Exception) { } // expect
    }
}
