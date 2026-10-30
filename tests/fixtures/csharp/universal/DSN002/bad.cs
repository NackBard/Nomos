namespace M.A
{
    public class X { public M.B.Y? Other; } // expect
}
namespace M.B
{
    public class Y { public M.A.X? Back; }
}
