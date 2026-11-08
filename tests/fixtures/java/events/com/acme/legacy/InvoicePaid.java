package com.acme.legacy;

import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * Same simple event name as `com.acme.billing.InvoiceService.InvoicePaid`, in a
 * different package. Nothing publishes this one.
 */
@Component
public class InvoicePaid {
  @EventListener
  public void onPaid(InvoicePaid event) {}
}
