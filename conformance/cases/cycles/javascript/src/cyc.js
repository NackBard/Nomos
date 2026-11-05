export class A {
  next() {
    return new B();
  }
}

export class B {
  next() {
    return new C();
  }
}

export class C {
  next() {
    return new A();
  }
}

export class D {
  peer = new E();
  ring = new A();
}

export class E {
  peer() {
    return new D();
  }
}
