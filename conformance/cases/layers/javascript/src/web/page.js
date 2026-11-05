import { Entity } from "../domain/entity.js";
import { Tool } from "../extra/tool.js";
import { Svc } from "../services/svc.js";

export class Page {
  service = new Svc();
  shortcut = new Entity();
  helper = new Tool();
}
