namespace F;
public class C
{
    private const string ApiKey = "abc123def456"; // expect
    public string Password { get; } = "hunter2-x"; // expect
    public string Aws() { var key = "AKIAIOSFODNN7EXAMPLE"; return key; } // expect
}
