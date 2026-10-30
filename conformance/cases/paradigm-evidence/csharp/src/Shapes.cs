namespace Pe.Shapes;

public interface IShape
{
}

public abstract class ShapeBase
{
    public int Id;
}

public class Square : ShapeBase
{
    public int Side;
}
