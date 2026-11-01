namespace Smell.Report;

public class Printer
{
    private int _copies;
    private int _width;
    private int _depth;

    public Printer()
    {
        _copies = 1;
    }

    public int Envy(Smell.Data.Order order)
    {
        return order.Price + order.Tax + order.Fee;
    }

    public int Balanced(Smell.Data.Order order)
    {
        return order.Price + order.Tax + order.Fee + _copies + _width + _depth;
    }

    public int Few(Smell.Data.Order order)
    {
        return order.Price + order.Tax;
    }

    public int ReadsMoney(Smell.Data.Money money)
    {
        return money.Amount + money.Cents + money.Rate;
    }

    public static int Sum(Smell.Data.Order order)
    {
        return order.Price + order.Tax + order.Fee;
    }
}
