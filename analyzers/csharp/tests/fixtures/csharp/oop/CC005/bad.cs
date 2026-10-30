namespace F;
public class bad_name { } // expect
public interface Reader { } // expect
public class Good
{
    public void do_it(int Bad) { } // expect
}
