namespace F;
public class Rules
{
    public bool Check(int a, int b) => a > 0 && b > 0;
    public int Pick(int a) => Math.Sign(a);
}
