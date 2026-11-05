export class Top {
  left() { return new Mid1(); }
  right() { return new Mid2(); }
}

export class Mid1 {
  end() { return new Bottom(); }
}

export class Mid2 {
  end() { return new Bottom(); }
}

export class Bottom {}

export class Self {
  next() { return new Self(); }
}
