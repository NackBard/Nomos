import { Entity, Repo } from "./domain.js";

export class SqlRepo extends Repo {
  cache = new Entity();
}
