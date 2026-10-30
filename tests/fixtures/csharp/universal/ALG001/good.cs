namespace F;
public class Node { public List<Node> Items = new(); }
public class C
{
    public int Walk(List<Node> nodes)
    {
        var n = 0;
        foreach (var node in nodes) { foreach (var item in node.Items) { n++; } }
        return n;
    }
    public int Search(int[] a, int low, int high, int key)
    {
        if (low > high) return -1;
        var mid = (low + high) / 2;
        if (a[mid] == key) return mid;
        if (a[mid] < key) return Search(a, mid + 1, high, key);
        return Search(a, low, mid - 1, key);
    }
    public int Depth(Node node) => 1 + node.Items.Select(i => Depth(i)).DefaultIfEmpty(0).Max();
}
