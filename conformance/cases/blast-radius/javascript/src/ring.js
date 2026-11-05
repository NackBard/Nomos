import { C4 } from "./chain.js";

export class R1 {
  next() { return new R2(); }
}

export class R2 {
  next() { return new R3(); }
}

export class R3 {
  next() { return new R1(); }
  end = new Leaf();
}

export class Tail {
  head = new R1();
}

export class Leaf {
  last = new C4();
}
