namespace Metrics;

public class Basics
{
    public static int Straight(int a)
    {
        return a + 1;
    }

    // A comment line inside the type: it counts toward lines but not toward loc.
    public static int Branches(int a, int b)
    {
        if (a > 0 && b > 0)
        {
            return 1;
        }
        else if (a < 0 || b < 0)
        {
            return -1;
        }

        return 0;
    }

    public static int Loops(int[] items, int limit)
    {
        var total = 0;
        foreach (var item in items)
        {
            for (var i = 0; i < limit; i++)
            {
                if (item > i)
                {
                    total += item;
                }
            }
        }

        return total;
    }

    public static string Switches(int kind, string text)
    {
        try
        {
            switch (kind)
            {
                case 1:
                    return "one";
                case 2:
                    return "two";
                default:
                    return text;
            }
        }
        catch (System.InvalidOperationException)
        {
            return kind > 0 ? "error" : "unknown";
        }
    }
}
