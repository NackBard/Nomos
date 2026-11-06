package pa.lambdas;

import java.util.Arrays;

public class Scanner {
    public static int scan(int[] xs) {
        return Arrays.stream(xs).filter(x -> Arrays.stream(xs).anyMatch(y -> y == x)).findFirst().orElse(0);
    }
}
