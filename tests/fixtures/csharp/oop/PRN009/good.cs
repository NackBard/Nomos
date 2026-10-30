namespace F;
public class B { public int V; }
public class A { public B Bb = new(); public int Value => Bb.V; }
public class Client
{
    public int Go(A a) => a.Value;
    public int Count(List<int> items) => items.Where(i => i > 0).Select(i => i * 2).OrderBy(i => i).ToList().Count;
}
