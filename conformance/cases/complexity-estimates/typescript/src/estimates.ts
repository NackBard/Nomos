export function constant(a: number): number {
  return a + 1;
}

export function linear(items: number[]): number {
  let n = 0;
  for (const x of items) {
    n += x;
  }
  return n;
}

export function quadratic(a: number[], b: number[]): number {
  let n = 0;
  for (const x of a) {
    for (const y of b) {
      n += x * y;
    }
  }
  return n;
}

export function halving(size: number): number {
  let steps = 0;
  for (let i = size; i > 0; i /= 2) {
    steps++;
  }
  return steps;
}

export function linearLog(items: number[]): number {
  let n = 0;
  for (const x of items) {
    n += halving(x);
  }
  return n;
}

export function fixed(): number {
  let n = 0;
  for (let i = 0; i < 10; i++) {
    n += i;
  }
  return n;
}

export function fib(n: number): number {
  if (n < 2) {
    return n;
  }
  return fib(n - 1) + fib(n - 2);
}

export function factorial(n: number): number {
  if (n < 2) {
    return 1;
  }
  return n * factorial(n - 1);
}

export function search(items: number[], low: number, high: number): number {
  if (low >= high) {
    return low;
  }
  const mid = Math.floor((low + high) / 2);
  if (items[mid] > 0) {
    return search(items, low, mid);
  }
  return search(items, mid, high);
}

export function cubicViaCallee(items: number[]): number {
  let n = 0;
  for (const _ of items) {
    n += quadratic(items, items);
  }
  return n;
}
