namespace F;
public class Order { public int Price { get; set; } public int Tax { get; set; } public int Fee { get; set; } }
public class Printer
{
    private int _copies;
    public int Total(Order o) => o.Price + o.Tax + o.Fee; // expect
    public int Copies() => _copies;
}
