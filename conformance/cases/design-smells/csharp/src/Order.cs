namespace Smell.Data;

public class Order
{
    public int Price;
    public int Tax;
    public int Fee;
}

public struct Money
{
    public int Amount;
    public int Cents;
    public int Rate;
}
