namespace F;
public interface ILog { }
public class Worker
{
    private readonly ILog _log;
    public Worker(ILog log) { _log = log; }
    public object Run() => _log;
}
