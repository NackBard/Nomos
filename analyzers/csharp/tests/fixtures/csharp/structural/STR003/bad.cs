namespace F;
public class Huge // expect
{
    public int A;
    public int B;
    public int Pick() { if (A > B) { return A; } return B; }
}
