namespace F;
public class Data { public int A { get; set; } public int B { get; set; } public int C { get; set; } }
public class Manager // expect
{
    private int _x, _y;
    public int One(Data d) { if (d.A > 0) return _x; return d.B; }
    public int Two(Data d) { if (d.C > 0) return _y; return 0; }
}
