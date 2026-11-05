export class A {
  tag = 0;
}

export class B {}

export class C {}

export function route(x: unknown): number {
  if (x instanceof A) {
    return 1;
  }
  if (x instanceof B) {
    return 2;
  }
  if (x instanceof C) {
    return 3;
  }
  return 0;
}
