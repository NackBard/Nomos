package pa.records;

public class Child extends Base {
    private final int extra;

    public Child(int id, int extra) {
        super(id);
        this.extra = extra;
    }
}
