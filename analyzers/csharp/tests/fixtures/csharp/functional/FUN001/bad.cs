namespace F;
public class C
{
    private int _n;
    public int Next() // expect
    {
        _n++;
        return _n;
    }
    public string Stamp() => DateTime.Now.ToString(); // expect
}
