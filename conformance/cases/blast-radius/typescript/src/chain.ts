export class C1 {}

export class C2 {
  prev?: C1;
}

export class C3 {
  prev?: C2;
}

export class C4 {
  prev?: C3;
}
