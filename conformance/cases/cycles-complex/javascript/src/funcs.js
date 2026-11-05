export function even(n) {
  if (n === 0) {
    return true;
  }
  return odd(n - 1);
}

export function odd(n) {
  if (n === 0) {
    return false;
  }
  return even(n - 1);
}
