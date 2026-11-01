namespace Pa.Lambdas;

public class Scanner
{
    public static int Scan(int[] xs)
    {
        return System.Array.Find(xs, x => System.Array.Exists(xs, y => y == x));
    }
}
