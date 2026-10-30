namespace F;
public class D { public int V; }
public class C { public D Dd = new(); }
public class B { public C Cc = new(); }
public class A { public B Bb = new(); }
public class Client
{
    public int Go(A a) => a.Bb.Cc.Dd.V; // expect
}
