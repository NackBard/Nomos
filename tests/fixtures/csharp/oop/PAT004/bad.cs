namespace F;
public interface IListener { void Changed(); }
public class Subject // expect
{
    private readonly List<IListener> _all = new();
    public void Subscribe(IListener l) => _all.Add(l);
    public void Notify() { foreach (var l in _all) l.Changed(); }
}
public class Button // expect
{
    public event EventHandler? Clicked;
    public void Click() => Clicked?.Invoke(this, EventArgs.Empty);
}
