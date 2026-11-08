package com.acme.billing;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;

@Service
public class InvoiceService {
  private final ApplicationEventPublisher publisher;

  public InvoiceService(ApplicationEventPublisher publisher) {
    this.publisher = publisher;
  }

  public void pay(long invoiceId) {
    publisher.publishEvent(new InvoicePaid(invoiceId));
  }

  public static class InvoicePaid {
    private final long invoiceId;

    InvoicePaid(long invoiceId) {
      this.invoiceId = invoiceId;
    }

    public long invoiceId() {
      return invoiceId;
    }
  }
}
