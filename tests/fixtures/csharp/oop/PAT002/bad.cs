namespace F;
public interface IShape { }
public class Circle : IShape { }
public class Square : IShape { }
public static class Shapes
{
    public static IShape Make(int k) => k == 0 ? new Circle() : new Square(); // expect
}
