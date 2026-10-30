namespace F;
public class C
{
    public void Go()
    {
        try { Console.WriteLine(); }
        catch (IOException)
        {
            // Logging is best effort: a closed stream must not stop the job.
        }
        catch (Exception e) { Console.Error.WriteLine(e); }
    }
}
