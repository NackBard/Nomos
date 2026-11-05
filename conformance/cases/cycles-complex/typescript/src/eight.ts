export class P {
  next() { return new Q(); }
}

export class Q {
  back() { return new P(); }
  side() { return new S(); }
}

export class S {
  back() { return new Q(); }
}
