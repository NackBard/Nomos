/**
 * @param {(x: number) => number} f
 * @param {number} x
 */
export function twice(f, x) {
  return f(f(x));
}
