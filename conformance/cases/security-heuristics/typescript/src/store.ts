export const password = "hunter22";
export const title = "hunter22";
export const awsKey = "AKIAABCDEFGHIJKLMNOP";

export function query(name: string): string {
  return "SELECT id FROM users WHERE name = '" + name + "'";
}

export function fixed(): string {
  return "SELECT id FROM users";
}

export function formatted(id: string): string {
  return `DELETE FROM users WHERE id = ${id}`;
}
