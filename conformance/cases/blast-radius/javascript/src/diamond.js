export class Bottom {
  size() {
    return 1;
  }
}

export class Left extends Bottom {}

export class Right {
  shared = new Bottom();
}

export class Top {
  l = new Left();
  r = new Right();
}
