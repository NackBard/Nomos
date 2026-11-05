export class C1 {}

export class C2 {
  prev = new C1();
}

export class C3 {
  prev = new C2();
}

export class C4 {
  prev = new C3();
}
