export function none(a) {
  return a;
}

export function grows(items) {
  const list = [];
  for (const x of items) {
    list.push(x);
  }
  return list;
}

export function grid(a, b) {
  const list = [];
  for (const x of a) {
    for (const y of b) {
      list.push(x + y);
    }
  }
  return list.length;
}

export function sized(n) {
  return new Array(n);
}

export function literal() {
  return new Array(8);
}

export function deep(n) {
  if (n < 1) {
    return 0;
  }
  return deep(n - 1);
}

export class Box {
  size = 0;
}

export function newInNested(a, b) {
  let n = 0;
  for (const x of a) {
    for (const y of b) {
      n += new Box().size + x + y;
    }
  }
  return n;
}

export function newInLoop(a) {
  let n = 0;
  for (const x of a) {
    n += new Box().size + x;
  }
  return n;
}
