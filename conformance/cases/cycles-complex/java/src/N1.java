package cx.ring;

public class N1 {
    public N2 next;
}

class N2 {
    public N3 next;
    public N4 skip;
}

class N3 {
    public N4 next;
}

class N4 {
    public N5 next;
}

class N5 {
    public N1 next;
}
