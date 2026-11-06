package cx.dag;

public class Top {
    public Mid1 m1;
    public Mid2 m2;
}

class Mid1 {
    public Bottom end;
}

class Mid2 {
    public Bottom end;
}

class Bottom {
}

class Self {
    public Self next;
}
