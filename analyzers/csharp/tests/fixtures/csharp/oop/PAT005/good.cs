namespace F;
public interface IStore { int Get(); }
public class Db : IStore { public int Get() => 1; }
