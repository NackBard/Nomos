namespace Pat.Code;

public class Engine
{
    public int Start() => 1;

    public int Stop() => 0;

    public int Idle() => 2;
}

public class Driver
{
    private readonly Engine _engine = new Engine();

    public int Start() => _engine.Start();

    public int Stop() => _engine.Stop();

    public int Idle() => _engine.Idle();
}
