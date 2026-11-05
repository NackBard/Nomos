export const password = "hunter22";

export function find(name: string): string {
  return "SELECT id FROM items WHERE name = '" + name + "'";
}

export function sum(a: number, b: number, c: number, d: number, e: number, f: number): number {
  return a + b + c + d + e + f;
}
