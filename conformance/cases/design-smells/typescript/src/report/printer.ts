import { Order } from "../data/order";

export class Printer {
  private copies = 1;
  private width = 0;
  private depth = 0;

  envy(order: Order): number {
    return order.price + order.tax + order.fee;
  }

  balanced(order: Order): number {
    return order.price + order.tax + order.fee + this.copies + this.width + this.depth;
  }

  few(order: Order): number {
    return order.price + order.tax;
  }
}

export function newPrinter(): Printer {
  return new Printer();
}

export function sum(order: Order): number {
  return order.price + order.tax + order.fee;
}
