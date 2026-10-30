namespace F;
public class C
{
    private const string PasswordPrompt = "Enter your password:";
    public string Title { get; } = "hello-world";
    public string Key() => Environment.GetEnvironmentVariable("API_KEY") ?? "";
}
