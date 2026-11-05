export interface Shape {
  area(): number;
}

export interface Named extends Shape {
  readonly label: string;
  name(): string;
}

export class Cell {
  x = 0;
  y = 0;
}

export abstract class Base {
  protected constructor(private readonly title: string) {}

  name(): string {
    return this.title;
  }

  abstract area(): number;
}

export class Square extends Base implements Shape {
  static count = 0;
  side = 1;
  cells: Cell[] = [];
  byKey: Map<string, Cell> = new Map();
  #secret?: Cell;

  static create(): Square {
    return new Square("square");
  }

  get perimeter(): number {
    return this.side * 4;
  }

  set perimeter(value: number) {
    this.side = value / 4;
  }

  area(): number {
    return this.side * this.side;
  }

  resize(by: number, ...labels: string[]): [number, string[]] {
    const old = this.side;
    this.side *= by;
    return [old, labels];
  }
}

export class Circle {
  readonly label = "circle";
  area(): number { return 3; }
  name(): string { return this.label; }
}

export enum Color {
  Red,
  Green,
}

export class Box<T> {
  item?: T;
}

export type Point = { x: number; y: number };

export function paint(s: Shape): number {
  return s.area();
}

export const twice = (n: number): number => n * 2;
