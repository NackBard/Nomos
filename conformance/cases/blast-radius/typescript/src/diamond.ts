export class Bottom {
  size(): number {
    return 1;
  }
}

export class Left extends Bottom {}

export class Right {
  shared?: Bottom;
}

export class Top {
  l?: Left;
  r?: Right;
}
