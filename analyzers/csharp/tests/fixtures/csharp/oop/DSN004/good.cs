namespace F;
public class Account
{
    private int _balance;
    public int Add(int v) { if (v > 0) _balance += v; return _balance; }
    public int Take(int v) { if (v < _balance) _balance -= v; return _balance; }
}
