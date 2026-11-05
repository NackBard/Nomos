import { Entity } from "../domain/entity";
import { Tool } from "../extra/tool";
import { Svc } from "../services/svc";

export class Page {
  service = new Svc();
  shortcut = new Entity();
  helper = new Tool();
}
