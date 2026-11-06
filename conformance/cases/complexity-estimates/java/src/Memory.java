package alg.code;

import java.util.ArrayList;
import java.util.List;

public class Memory {
    public int none(int a) {
        return a;
    }

    public List<Integer> grows(int[] items) {
        List<Integer> list = new ArrayList<>();
        for (int x : items) {
            list.add(x);
        }
        return list;
    }

    public int grid(int[] a, int[] b) {
        List<Integer> list = new ArrayList<>();
        for (int x : a) {
            for (int y : b) {
                list.add(x + y);
            }
        }
        return list.size();
    }

    public int[] sized(int n) {
        return new int[n];
    }

    public int[] constant() {
        return new int[8];
    }

    public int deep(int n) {
        if (n < 1) {
            return 0;
        }
        return deep(n - 1);
    }

    public int newInNested(int[] a, int[] b) {
        int n = 0;
        for (int x : a) {
            for (int y : b) {
                n += new Box().size + x + y;
            }
        }
        return n;
    }

    public int newInLoop(int[] a) {
        int n = 0;
        for (int x : a) {
            n += new Box().size + x;
        }
        return n;
    }
}

class Box {
    public int size;
}
