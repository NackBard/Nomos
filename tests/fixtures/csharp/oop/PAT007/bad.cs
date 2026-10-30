namespace F;
public class Url { }
public class UrlBuilder // expect
{
    public UrlBuilder Host(string h) { return this; }
    public UrlBuilder Port(int p) { return this; }
    public Url Build() => new Url();
}
