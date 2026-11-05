export function even(n: number): boolean {
  if (n === 0) {
    return true;
  }
  return odd(n - 1);
}

export function odd(n: number): boolean {
  if (n === 0) {
    return false;
  }
  return even(n - 1);
}
