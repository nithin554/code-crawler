package com.acme.events;

public class OrderPlaced {
  private final String orderId;

  public OrderPlaced(String orderId) {
    this.orderId = orderId;
  }

  public String orderId() {
    return orderId;
  }
}
