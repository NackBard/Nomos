namespace Oc;

public class Data
{
    public int Value;
    public int Other;
}

public class Mixed
{
    private int a;
    private int b;
    public Data Source;

    public void IncA()
    {
        a++;
    }

    public int ReadA()
    {
        return a;
    }

    public void IncB()
    {
        b++;
    }

    public int Peek()
    {
        return Source.Value + Source.Other;
    }
}

public class Derived : Mixed
{
}
