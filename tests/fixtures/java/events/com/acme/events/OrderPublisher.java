package com.acme.events;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;

@Service
public class OrderPublisher {
  private final ApplicationEventPublisher publisher;

  public OrderPublisher(ApplicationEventPublisher publisher) {
    this.publisher = publisher;
  }

  /** Literal constructor argument: the event type is unambiguous. */
  public void place(String orderId) {
    publisher.publishEvent(new OrderPlaced(orderId));
  }

  /** Local variable of a declared event type. */
  public void cancel(String orderId) {
    OrderCancelled cancelled = new OrderCancelled(orderId);
    publisher.publishEvent(cancelled);
  }

  /** Only the declared parameter type is known, not what the caller passes. */
  public void republish(Object event) {
    publisher.publishEvent(event);
  }

  /** `String.valueOf` is an Object.prototype name, not a publication. */
  public String describe(OrderPlaced event) {
    return String.valueOf(event);
  }
}
