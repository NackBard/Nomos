export function scan(xs: number[]): boolean {
  return xs.some((x) => {
    return xs.some((y) => {
      return y === x;
    });
  });
}
