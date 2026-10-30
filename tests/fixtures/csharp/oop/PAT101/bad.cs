namespace F;
public interface ILog { }
public class Worker
{
    private readonly IServiceProvider _sp;
    public Worker(IServiceProvider sp) { _sp = sp; }
    public object? Run() => _sp.GetService(typeof(ILog)); // expect
}
