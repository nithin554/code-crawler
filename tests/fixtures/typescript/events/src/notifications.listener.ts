import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";

@Injectable()
export class NotificationsListener {
  @OnEvent("order.placed")
  handlePlaced(payload: { orderId: string }): void {
    this.send(payload.orderId);
  }

  @OnEvent("order.cancelled")
  handleCancelled(payload: { orderId: string }): void {
    this.refund(payload.orderId);
  }

  private send(orderId: string): void {}

  private refund(orderId: string): void {}
}
