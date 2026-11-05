import type { Order } from "../data/order";

export class God {
  private a = 0;
  private b = 0;
  private c = 0;
  private d = 0;

  one(order: Order): number {
    if (order.price > 0) {
      return this.a;
    }
    return 0;
  }

  two(order: Order): number {
    if (order.tax > 0) {
      return this.b;
    }
    return 0;
  }

  three(order: Order): number {
    if (order.fee > 0) {
      return this.c;
    }
    return 0;
  }

  four(order: Order): number {
    if (order.price > 0) {
      return this.d;
    }
    return 0;
  }
}
