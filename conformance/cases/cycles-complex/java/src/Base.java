package cx.mixed;

public class Base {
    public Object make() {
        return new Derived();
    }
}

class Derived extends Base {
}
