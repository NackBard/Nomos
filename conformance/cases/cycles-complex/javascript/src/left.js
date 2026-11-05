import { Y1 } from "./right.js";

export class X1 {
  next() { return new X2(); }
}

export class X2 {
  back() { return new X1(); }
  bridge() { return new Y1(); }
}
