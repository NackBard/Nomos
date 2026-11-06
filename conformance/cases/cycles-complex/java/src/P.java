package cx.eight;

public class P {
    public Q next;
}

class Q {
    public P back;
    public S side;
}

class S {
    public Q back;
}
