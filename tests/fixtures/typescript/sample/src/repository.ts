export interface Repository<T> {
  create(id: string): T;
  find(id: string): T | undefined;
}

export class OrderRepository implements Repository<Order> {
  private readonly rows: Order[] = [];

  create(id: string): Order {
    const existing = this.find(id);
    if (existing) {
      return existing;
    }
    const order: Order = { id };
    this.rows.push(order);
    return order;
  }

  find(id: string): Order | undefined {
    return this.rows.find((row) => row.id === id);
  }
}

export interface Order {
  id: string;
}
