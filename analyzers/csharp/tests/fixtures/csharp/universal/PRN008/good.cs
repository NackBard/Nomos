namespace F;
internal interface IShape { }
internal class Circle : IShape { }
internal class Square : IShape
{
    public int Go() => Helper(1);
    private int Helper(int used) => used;
}
