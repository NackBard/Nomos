import { Entity, Repo } from "./domain.js";

export class OrderService {
  repo = new Repo();
  last = new Entity();
}
