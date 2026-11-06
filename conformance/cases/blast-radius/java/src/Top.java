package blast.diamond;

class Bottom {
    public int size() {
        return 1;
    }
}

class Left extends Bottom {
}

class Right {
    public Bottom shared;
}

public class Top {
    public Left l;
    public Right r;
}
