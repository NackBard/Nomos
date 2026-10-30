namespace F;
public class Shape { }
public class Circle : Shape { }
public class Square : Shape { }
public class Line : Shape { }
public class Painter
{
    public int Area(Shape s) // expect
    {
        if (s is Circle) return 1;
        if (s is Square) return 2;
        if (s is Line) return 3;
        return 0;
    }
}
