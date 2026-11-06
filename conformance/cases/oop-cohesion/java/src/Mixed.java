package oc;

class Data {
    public int value;
    public int other;
}

public class Mixed {
    private int a;
    private int b;
    public Data source;

    public void incA() {
        a++;
    }

    public int readA() {
        return a;
    }

    public void incB() {
        b++;
    }

    public int peek() {
        return source.value + source.other;
    }
}

class Derived extends Mixed {
}
