namespace Alg.Code;

public class Memory
{
    public int None(int a)
    {
        return a;
    }

    public System.Collections.Generic.List<int> Grows(int[] items)
    {
        var list = new System.Collections.Generic.List<int>();
        foreach (var x in items)
        {
            list.Add(x);
        }
        return list;
    }

    public int Grid(int[] a, int[] b)
    {
        var list = new System.Collections.Generic.List<int>();
        foreach (var x in a)
        {
            foreach (var y in b)
            {
                list.Add(x + y);
            }
        }
        return list.Count;
    }

    public int[] Sized(int n)
    {
        return new int[n];
    }

    public int[] Constant()
    {
        return new int[8];
    }

    public int Deep(int n)
    {
        if (n < 1)
        {
            return 0;
        }
        return Deep(n - 1);
    }

    public int NewInNested(int[] a, int[] b)
    {
        var n = 0;
        foreach (var x in a)
        {
            foreach (var y in b)
            {
                n += new Box().Size + x + y;
            }
        }
        return n;
    }

    public int NewInLoop(int[] a)
    {
        var n = 0;
        foreach (var x in a)
        {
            n += new Box().Size + x;
        }
        return n;
    }
}

public class Box
{
    public int Size;
}
