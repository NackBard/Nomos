export const password = "hunter22";
export const title = "hunter22";
export const awsKey = "AKIAABCDEFGHIJKLMNOP";

export function query(name) {
  return "SELECT id FROM users WHERE name = '" + name + "'";
}

export function fixed() {
  return "SELECT id FROM users";
}

export function formatted(id) {
  return `DELETE FROM users WHERE id = ${id}`;
}
