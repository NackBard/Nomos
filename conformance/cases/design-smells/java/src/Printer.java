package smell.report;

import smell.data.Money;
import smell.data.Order;

public class Printer {
    private int copies;
    private int width;
    private int depth;

    public Printer() {
        copies = 1;
    }

    public int envy(Order order) {
        return order.price + order.tax + order.fee;
    }

    public int balanced(Order order) {
        return order.price + order.tax + order.fee + copies + width + depth;
    }

    public int few(Order order) {
        return order.price + order.tax;
    }

    public int readsMoney(Money money) {
        return money.amount() + money.cents() + money.rate();
    }

    public static int sum(Order order) {
        return order.price + order.tax + order.fee;
    }
}
