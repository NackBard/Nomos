export class A {
  next(): B {
    return new B();
  }
}

export class B {
  next(): C {
    return new C();
  }
}

export class C {
  next(): A {
    return new A();
  }
}

export class D {
  peer = new E();
  ring = new A();
}

export class E {
  peer(): D {
    return new D();
  }
}

// Only types refer to each other here: no cycle exists at run time.
export class F {
  peer?: G;
}

export class G {
  peer?: F;
}
