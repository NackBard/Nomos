namespace Shop.Domain
{
    public class Order // expect
    {
        public int Id { get; set; }
        public int Total { get; set; }
        public string Status { get; set; } = "";
    }
}
