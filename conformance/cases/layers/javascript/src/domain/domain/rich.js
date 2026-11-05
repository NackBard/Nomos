import { Entity as Outer } from "../entity.js";
import { Page } from "../../web/page.js";

export class Rich {
  base = new Outer();
  page = new Page();
}
