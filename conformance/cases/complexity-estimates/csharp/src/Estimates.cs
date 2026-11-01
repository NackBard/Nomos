namespace Alg.Code;

public class Estimates
{
    public int Constant(int a)
    {
        return a + 1;
    }

    public int Linear(int[] items)
    {
        var n = 0;
        foreach (var x in items)
        {
            n += x;
        }
        return n;
    }

    public int Quadratic(int[] a, int[] b)
    {
        var n = 0;
        foreach (var x in a)
        {
            foreach (var y in b)
            {
                n += x * y;
            }
        }
        return n;
    }

    public int Halving(int size)
    {
        var steps = 0;
        for (var i = size; i > 0; i /= 2)
        {
            steps++;
        }
        return steps;
    }

    public int LinearLog(int[] items)
    {
        var n = 0;
        foreach (var x in items)
        {
            n += Halving(x);
        }
        return n;
    }

    public int Fixed()
    {
        var n = 0;
        for (var i = 0; i < 10; i++)
        {
            n += i;
        }
        return n;
    }

    public int Fib(int n)
    {
        if (n < 2)
        {
            return n;
        }
        return Fib(n - 1) + Fib(n - 2);
    }

    public int Factorial(int n)
    {
        if (n < 2)
        {
            return 1;
        }
        return n * Factorial(n - 1);
    }

    public int Search(int[] items, int low, int high)
    {
        if (low >= high)
        {
            return low;
        }
        var mid = (low + high) / 2;
        if (items[mid] > 0)
        {
            return Search(items, low, mid);
        }
        return Search(items, mid, high);
    }

    public int CubicViaCallee(int[] items)
    {
        var n = 0;
        foreach (var x in items)
        {
            n += Quadratic(items, items);
        }
        return n;
    }
}
