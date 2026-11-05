export class Base {
  make() {
    return new Derived();
  }
}

export class Derived extends Base {}
