package blast.ring;

public class R1 {
    public R2 next;
}

class R2 {
    public R3 next;
}

class R3 {
    public R1 next;
    public Leaf end;
}

class Tail {
    public R1 head;
}

class Leaf {
    public blast.chain.C4 last;
}
