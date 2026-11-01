namespace F;
public class Base
{
    public void One() { }
    public void Two() { }
}
public class Unrelated : Base // expect
{
    public int Own() => 1;
}
public record RecordBase { public void First() { } public void Second() { } }
public record RecordChild : RecordBase { public int Own() => 1; } // expect
