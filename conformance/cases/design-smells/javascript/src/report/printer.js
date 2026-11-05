import { Order } from "../data/order.js";

export class Printer {
  #copies = 1;
  #width = 0;
  #depth = 0;

  /** @param {Order} order */
  envy(order) {
    return order.price + order.tax + order.fee;
  }

  /** @param {Order} order */
  balanced(order) {
    return order.price + order.tax + order.fee + this.#copies + this.#width + this.#depth;
  }

  /** @param {Order} order */
  few(order) {
    return order.price + order.tax;
  }
}

export function newPrinter() {
  return new Printer();
}

/** @param {Order} order */
export function sum(order) {
  return order.price + order.tax + order.fee;
}
