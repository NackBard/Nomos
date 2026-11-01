namespace Pat.Code;

public class Locator
{
    public object GetService(int id) => id;
}

public class Handler
{
    private readonly Locator _locator = new Locator();

    public object Run() => _locator.GetService(1);
}
