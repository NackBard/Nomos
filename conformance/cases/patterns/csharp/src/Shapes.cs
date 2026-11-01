namespace Pat.Code;

public interface IShape
{
    int Area();
}

public class Circle : IShape
{
    public int Area() => 3;
}

public class Square : IShape
{
    public int Area() => 4;
}

public class ShapeMaker
{
    public IShape Make(int kind)
    {
        if (kind == 0)
        {
            return new Circle();
        }
        return new Square();
    }
}

public class Canvas
{
    private readonly IShape _shape;

    public Canvas(IShape shape)
    {
        _shape = shape;
    }

    public int Draw() => _shape.Area();
}
