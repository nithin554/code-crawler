package com.acme.events;

public class OrderCancelled {
  private final String orderId;

  public OrderCancelled(String orderId) {
    this.orderId = orderId;
  }

  public String orderId() {
    return orderId;
  }
}
