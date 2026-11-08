import { Injectable } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";

@Injectable()
export class OrdersService {
  constructor(private readonly events: EventEmitter2) {}

  place(orderId: string): void {
    this.events.emit("order.placed", { orderId });
  }

  cancel(orderId: string): void {
    this.events.emit("order.cancelled", { orderId });
  }

  /** Nothing subscribes to this channel. */
  ship(orderId: string): void {
    this.events.emit("order.shipped", { orderId });
  }

  /** The channel is only known at run time. */
  raw(channel: string): void {
    this.events.emit(channel, {});
  }
}
