package sup.code;

public class Loops {
    public int reported(int[] a) { int n = 0; for (int x : a) { for (int y : a) { n += x * y; } } return n; }

    // nomos-disable-next-line ALG001
    public int next(int[] a) { int n = 0; for (int x : a) { for (int y : a) { n += x * y; } } return n; }

    public int same(int[] a) { int n = 0; for (int x : a) { for (int y : a) { n += x * y; } } return n; } // nomos-disable-line ALG001

    // nomos-disable-next-line CC001
    public int otherRule(int[] a) { int n = 0; for (int x : a) { for (int y : a) { n += x * y; } } return n; }

    public int reasoned(int[] a) { int n = 0; for (int x : a) { for (int y : a) { n += x * y; } } return n; } // nomos-disable-line alg001, CC003 -- input is bounded
}
