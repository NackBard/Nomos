export class N1 {
  next() { return new N2(); }
}

export class N2 {
  next() { return new N3(); }
  skip() { return new N4(); }
}

export class N3 {
  next() { return new N4(); }
}

export class N4 {
  next() { return new N5(); }
}

export class N5 {
  next() { return new N1(); }
}
