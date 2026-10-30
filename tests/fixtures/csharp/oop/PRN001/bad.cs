namespace F;
public interface IA { } public interface IB { } public interface IC { } public interface ID { } public interface IE { } public interface IG { }
public class Hub // expect
{
    public Hub(IA a, IB b, IC c, ID d, IE e, IG g) { }
    public void M1() { }
    public void M2() { }
    public void M3() { }
}
