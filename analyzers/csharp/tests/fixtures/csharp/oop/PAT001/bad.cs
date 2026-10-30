namespace F;
public class Config // expect
{
    private static readonly Config Instance = new();
    private Config() { }
    public static Config Get() => Instance;
}
