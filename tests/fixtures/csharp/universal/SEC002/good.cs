namespace F;
public class C
{
    public string Read(Stream s) => new StreamReader(s).ReadToEnd();
}
