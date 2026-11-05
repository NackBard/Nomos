import { Order } from "../data/order.js";

export class God {
  #a = 0;
  #b = 0;
  #c = 0;
  #d = 0;

  /** @param {Order} order */
  one(order) {
    if (order.price > 0) {
      return this.#a;
    }
    return 0;
  }

  /** @param {Order} order */
  two(order) {
    if (order.tax > 0) {
      return this.#b;
    }
    return 0;
  }

  /** @param {Order} order */
  three(order) {
    if (order.fee > 0) {
      return this.#c;
    }
    return 0;
  }

  /** @param {Order} order */
  four(order) {
    if (order.price > 0) {
      return this.#d;
    }
    return 0;
  }
}
