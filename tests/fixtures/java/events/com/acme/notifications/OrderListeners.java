package com.acme.notifications;

import com.acme.events.OrderCancelled;
import com.acme.events.OrderPlaced;
import org.springframework.context.ApplicationEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

@Component
public class OrderListeners {
  @EventListener
  public void onPlaced(OrderPlaced event) {
    event.orderId();
  }

  @EventListener
  public void onCancelled(OrderCancelled event) {
    event.orderId();
  }

  /**
   * Listens to every application event. A publication of `OrderPlaced` does
   * reach this method at run time through subtype dispatch, which the graph does
   * not model, so no edge is expected here.
   */
  @EventListener
  public void onAny(ApplicationEvent event) {}
}
