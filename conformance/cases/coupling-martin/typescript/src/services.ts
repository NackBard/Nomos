import { Entity, type Repo } from "./domain";

export class OrderService {
  repo?: Repo;
  last: Entity = new Entity();
}
