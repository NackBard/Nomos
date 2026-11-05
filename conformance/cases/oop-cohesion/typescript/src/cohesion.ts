export class Data {
  value = 0;
  other = 0;
}

export class Mixed {
  private a = 0;
  private b = 0;
  source = new Data();

  incA(): void {
    this.a++;
  }

  readA(): number {
    return this.a;
  }

  incB(): void {
    this.b++;
  }

  peek(): number {
    return this.source.value + this.source.other;
  }
}

export class Derived extends Mixed {}
