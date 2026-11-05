export class Y1 {
  next() { return new Y2(); }
}

export class Y2 {
  back() { return new Y1(); }
}
