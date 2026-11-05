export let counter = 0;

export function add(a: number, b: number): number {
  return a + b;
}

export function bump(): void {
  counter++;
}
