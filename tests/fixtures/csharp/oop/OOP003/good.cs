namespace F;
public abstract class Shape { public abstract int Area(); }
public class Circle : Shape { public override int Area() => 1; }
public class Painter
{
    public int Area(Shape s) => s.Area();
}
