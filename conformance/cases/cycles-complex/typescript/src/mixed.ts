export class Base {
  make(): unknown {
    return new Derived();
  }
}

export class Derived extends Base {}
