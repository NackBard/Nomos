namespace App.Core
{
    public class Stable { } // expect
}
namespace App.Web
{
    public class Page { public App.Core.Stable S = new(); }
}
