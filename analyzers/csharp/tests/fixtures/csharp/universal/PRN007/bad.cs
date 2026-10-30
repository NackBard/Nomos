namespace F;
public class Rules
{
    public bool Check(int a, int b, int c, int d, int e)
    {
        if (a > 0 && b > 0 && c > 0 && d > 0 && e > 0) // expect
            return true;
        return false;
    }
    public int Pick(int a) => a > 0 ? 1 : a < 0 ? -1 : 0; // expect
}
