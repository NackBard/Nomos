package alg.code;

public class Estimates {
    public int constant(int a) {
        return a + 1;
    }

    public int linear(int[] items) {
        int n = 0;
        for (int x : items) {
            n += x;
        }
        return n;
    }

    public int quadratic(int[] a, int[] b) {
        int n = 0;
        for (int x : a) {
            for (int y : b) {
                n += x * y;
            }
        }
        return n;
    }

    public int halving(int size) {
        int steps = 0;
        for (int i = size; i > 0; i /= 2) {
            steps++;
        }
        return steps;
    }

    public int linearLog(int[] items) {
        int n = 0;
        for (int x : items) {
            n += halving(x);
        }
        return n;
    }

    public int fixed() {
        int n = 0;
        for (int i = 0; i < 10; i++) {
            n += i;
        }
        return n;
    }

    public int fib(int n) {
        if (n < 2) {
            return n;
        }
        return fib(n - 1) + fib(n - 2);
    }

    public int factorial(int n) {
        if (n < 2) {
            return 1;
        }
        return n * factorial(n - 1);
    }

    public int search(int[] items, int low, int high) {
        if (low >= high) {
            return low;
        }
        int mid = (low + high) / 2;
        if (items[mid] > 0) {
            return search(items, low, mid);
        }
        return search(items, mid, high);
    }

    public int cubicViaCallee(int[] items) {
        int n = 0;
        for (int x : items) {
            n += quadratic(items, items);
        }
        return n;
    }
}
