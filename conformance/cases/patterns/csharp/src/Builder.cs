namespace Pat.Code;

public class QueryBuilder
{
    public QueryBuilder Where() => this;

    public QueryBuilder Order() => this;

    public string Build() => "q";
}
