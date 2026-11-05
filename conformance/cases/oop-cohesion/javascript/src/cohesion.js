export class Data {
  value = 0;
  other = 0;
}

export class Mixed {
  #a = 0;
  #b = 0;
  source = new Data();

  incA() {
    this.#a++;
  }

  readA() {
    return this.#a;
  }

  incB() {
    this.#b++;
  }

  peek() {
    return this.source.value + this.source.other;
  }
}

export class Derived extends Mixed {}
