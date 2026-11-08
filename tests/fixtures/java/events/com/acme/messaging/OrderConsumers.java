package com.acme.messaging;

import org.springframework.jms.annotation.JmsListener;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
public class OrderConsumers {
  @KafkaListener(topics = "orders")
  public void consumeOrder(String payload) {}

  @JmsListener(destination = "queue.billing")
  public void consumeInvoice(String payload) {}
}
