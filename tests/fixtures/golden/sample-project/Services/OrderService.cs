using Sample.Domain;

namespace Sample.Services;

public interface INotifier { void Send(string message); }

public class Notifier : INotifier
{
    public void Send(string message) => Console.WriteLine(message);
}

public class OrderService
{
    private const string ApiKey = "abc123def456";

    public string Describe(Order order)
    {
        switch (order.Status)
        {
            case OrderStatus.New: return "new";
            case OrderStatus.Paid: return "paid";
            default: return "shipped";
        }
    }

    public int Matches(List<Order> orders, List<int> ids)
    {
        var count = 0;
        foreach (var order in orders)
        {
            if (ids.Contains(order.Id)) count++; // nomos-disable-line ALG002
        }
        return count;
    }

    public int Pairs(int[] left, int[] right)
    {
        var total = 0;
        foreach (var a in left)
            foreach (var b in right)
                total += a * b;
        return total;
    }

    // TODO: replace with a real gateway
    public void Pay(Order order)
    {
        var notifier = new Notifier();
        notifier.Send(order.Id.ToString());
    }
}
