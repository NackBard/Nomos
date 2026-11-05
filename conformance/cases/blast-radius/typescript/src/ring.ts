import type { C4 } from "./chain";

export class R1 {
  next() { return new R2(); }
}

export class R2 {
  next() { return new R3(); }
}

export class R3 {
  next() { return new R1(); }
  end?: Leaf;
}

export class Tail {
  head = new R1();
}

export class Leaf {
  last?: C4;
}
