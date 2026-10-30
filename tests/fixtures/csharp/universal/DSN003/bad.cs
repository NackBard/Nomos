namespace Shop.Infrastructure
{
    public class Db { }
}
namespace Shop.Domain
{
    public class Order { public Shop.Infrastructure.Db? Storage; } // expect
}
