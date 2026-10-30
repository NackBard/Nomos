namespace Sample.Domain;

public enum OrderStatus { New, Paid, Shipped }

public class Order
{
    public int Id { get; set; }
    public int Total { get; set; }
    public OrderStatus Status { get; set; }
    public Sample.Services.Notifier? Listener;
}
