import { Entity as Outer } from "../entity";
import { Page } from "../../web/page";

export class Rich {
  base = new Outer();
  page = new Page();
}
