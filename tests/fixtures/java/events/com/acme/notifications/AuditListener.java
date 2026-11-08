package com.acme.notifications;

import com.acme.events.OrderPlaced;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

@Component
public class AuditListener {
  @TransactionalEventListener
  public void onPlaced(OrderPlaced event) {}

  @TransactionalEventListener(phase = TransactionPhase.BEFORE_COMMIT)
  public void beforeCommit(OrderPlaced event) {}
}
