package ts;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

interface Shape {
    double area();
}

abstract class Base implements Shape {
    protected String name = "";

    public abstract double area();
}

enum Unit {
    MM,
    CM,
}

final class Square extends Base {
    public static final int SIDES = 4;
    private final double side;
    public static int created;
    public Unit unit;

    public Square(double side) {
        this.side = side;
    }

    @Override
    public double area() {
        return side * side;
    }
}

class Drawing<T> {
    private final List<T> items = new ArrayList<>();
    private Optional<Square> frame = Optional.empty();

    public void add(T item, String... tags) {
        items.add(item);
    }

    public static <T> Drawing<T> empty() {
        return new Drawing<>();
    }
}

class Painter {
    public double paint(Square square) {
        return square.area();
    }
}

record Point(int x, int y) {
}
