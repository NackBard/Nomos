import { SqlRepo } from "./infra";
import { OrderService } from "./services";

export class Program {
  service = new OrderService();
  repo: SqlRepo | undefined;
}
