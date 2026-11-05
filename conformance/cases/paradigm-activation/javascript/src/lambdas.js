export function scan(xs) {
  return xs.some((x) => {
    return xs.some((y) => {
      return y === x;
    });
  });
}
