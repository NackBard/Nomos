namespace F;
public interface IWorker // expect
{
    void Work();
    void Eat();
}
public class Robot : IWorker
{
    public void Work() { }
    public void Eat() { throw new NotImplementedException(); }
}
