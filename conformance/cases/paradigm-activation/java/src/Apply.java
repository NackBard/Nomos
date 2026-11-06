package pa.hof;

import java.util.function.Function;

public class Apply {
    public static int twice(Function<Integer, Integer> f, int x) {
        return f.apply(f.apply(x));
    }
}
