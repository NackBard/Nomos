export function twice(f: (x: number) => number, x: number): number {
  return f(f(x));
}
