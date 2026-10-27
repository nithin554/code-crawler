import { OrderService } from "./service";

const service = new OrderService();

export function main(): void {
  service.place("o-1");
}

main();
