namespace F;
public class Counter
{
    private int _n;
    public int Get() => _n;
    public void Inc() => _n++;
    public void Dec() => _n--;
    public void Reset() => _n = 0;
}
