import { Entity } from "./domain";
import type { Repo } from "./domain";

export class SqlRepo implements Repo {
  cache = new Entity();
}
