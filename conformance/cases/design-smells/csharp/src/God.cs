namespace Smell.Report;

public class God
{
    private int _a;
    private int _b;
    private int _c;
    private int _d;

    public int One(Smell.Data.Order order)
    {
        if (order.Price > 0)
        {
            return _a;
        }
        return 0;
    }

    public int Two(Smell.Data.Order order)
    {
        if (order.Tax > 0)
        {
            return _b;
        }
        return 0;
    }

    public int Three(Smell.Data.Order order)
    {
        if (order.Fee > 0)
        {
            return _c;
        }
        return 0;
    }

    public int Four(Smell.Data.Order order)
    {
        if (order.Price > 0)
        {
            return _d;
        }
        return 0;
    }
}
