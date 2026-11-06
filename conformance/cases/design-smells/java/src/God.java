package smell.report;

import smell.data.Order;

public class God {
    private int a;
    private int b;
    private int c;
    private int d;

    public int one(Order order) {
        if (order.price > 0) {
            return a;
        }
        return 0;
    }

    public int two(Order order) {
        if (order.tax > 0) {
            return b;
        }
        return 0;
    }

    public int three(Order order) {
        if (order.fee > 0) {
            return c;
        }
        return 0;
    }

    public int four(Order order) {
        if (order.price > 0) {
            return d;
        }
        return 0;
    }
}
