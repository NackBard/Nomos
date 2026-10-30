namespace F;
public interface ICompress { byte[] Run(byte[] d); }
public class Zip : ICompress { public byte[] Run(byte[] d) => d; }
public class Archiver
{
    private readonly ICompress _c;
    public Archiver(ICompress c) { _c = c; }
    public byte[] Save(byte[] d) => _c.Run(d);
}
