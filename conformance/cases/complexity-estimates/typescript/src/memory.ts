export function none(a: number): number {
  return a;
}

export function grows(items: number[]): number[] {
  const list: number[] = [];
  for (const x of items) {
    list.push(x);
  }
  return list;
}

export function grid(a: number[], b: number[]): number {
  const list: number[] = [];
  for (const x of a) {
    for (const y of b) {
      list.push(x + y);
    }
  }
  return list.length;
}

export function sized(n: number): number[] {
  return new Array<number>(n);
}

export function literal(): number[] {
  return new Array<number>(8);
}

export function deep(n: number): number {
  if (n < 1) {
    return 0;
  }
  return deep(n - 1);
}

export class Box {
  size = 0;
}

export function newInNested(a: number[], b: number[]): number {
  let n = 0;
  for (const x of a) {
    for (const y of b) {
      n += new Box().size + x + y;
    }
  }
  return n;
}

export function newInLoop(a: number[]): number {
  let n = 0;
  for (const x of a) {
    n += new Box().size + x;
  }
  return n;
}
