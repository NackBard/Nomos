namespace Sup.Code;

public class Loops
{
    public int Reported(int[] a) { var n = 0; foreach (var x in a) { foreach (var y in a) { n += x * y; } } return n; }

    // nomos-disable-next-line ALG001
    public int Next(int[] a) { var n = 0; foreach (var x in a) { foreach (var y in a) { n += x * y; } } return n; }

    public int Same(int[] a) { var n = 0; foreach (var x in a) { foreach (var y in a) { n += x * y; } } return n; } // nomos-disable-line ALG001

    // nomos-disable-next-line CC001
    public int OtherRule(int[] a) { var n = 0; foreach (var x in a) { foreach (var y in a) { n += x * y; } } return n; }

    public int Reasoned(int[] a) { var n = 0; foreach (var x in a) { foreach (var y in a) { n += x * y; } } return n; } // nomos-disable-line alg001, CC003 -- input is bounded
}
