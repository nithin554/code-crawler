import { Injectable } from "@nestjs/common";
import { OrderRepository, type Order } from "./repository";

@Injectable()
export class OrderService {
  constructor(private readonly repo: OrderRepository) {}

  place(id: string): Order {
    const order = this.repo.create(id);
    this.audit(order.id);
    return order;
  }

  private audit(id: string): void {
    console.log(`placed ${id}`);
  }
}
