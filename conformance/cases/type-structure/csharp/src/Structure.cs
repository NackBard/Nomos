using System.Collections.Generic;

namespace Ts;

public interface IShape
{
    double Area();
}

public abstract class Shape : IShape
{
    protected string Name { get; init; } = "";

    public abstract double Area();
}

public enum Unit
{
    Mm,
    Cm,
}

public sealed class Square : Shape
{
    public const int Sides = 4;
    private readonly double _side;
    public static int Created;
    public Unit Unit { get; set; }

    public Square(double side) => _side = side;

    public override double Area() => _side * _side;
}

public class Drawing<T>
{
    private readonly List<T> _items = new();
    public Square? Frame { get; set; }

    public void Add(T item, params string[] tags) => _items.Add(item);

    public static Drawing<T> Empty() => new();
}

public class Painter
{
    public double Paint(Square square) => square.Area();
}
