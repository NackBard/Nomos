import { SqlRepo } from "./infra.js";
import { OrderService } from "./services.js";

export class Program {
  service = new OrderService();
  repo = new SqlRepo();
}
