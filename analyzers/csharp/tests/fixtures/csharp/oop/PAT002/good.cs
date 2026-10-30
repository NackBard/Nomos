namespace F;
public interface IShape { }
public class Circle : IShape { }
public static class Shapes
{
    public static Circle Make() => new Circle();
}
