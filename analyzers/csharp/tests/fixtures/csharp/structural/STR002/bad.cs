namespace F;
public static class Globals
{
    public static int Counter; // expect
    public static string Name { get; set; } = ""; // expect
    public static int Next() { if (Counter > 0) { return 1; } return 0; }
}
