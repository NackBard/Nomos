namespace Shop.Domain
{
    public class Order
    {
        public int Id { get; set; }
        public int Total { get; private set; }
        public string Status { get; private set; } = "";
        public void Pay() { Status = "paid"; }
    }
}
namespace Shop.Api
{
    public class OrderDto { public int A { get; set; } public int B { get; set; } public int C { get; set; } }
}
