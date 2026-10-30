namespace F;
public class User { }
public class UserRepository // expect
{
    public User? GetById(int id) => null;
    public void Add(User u) { }
    public void Remove(User u) { }
}
