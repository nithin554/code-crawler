package com.acme.messaging;

import org.springframework.jms.core.JmsTemplate;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

@Service
public class OrderMessaging {
  private final KafkaTemplate<String, String> kafka;
  private final JmsTemplate jms;

  public OrderMessaging(KafkaTemplate<String, String> kafka, JmsTemplate jms) {
    this.kafka = kafka;
    this.jms = jms;
  }

  public void publishOrder(String payload) {
    kafka.send("orders", payload);
  }

  /** No consumer subscribes to this topic in the project. */
  public void publishPayments(String payload) {
    kafka.send("payments", payload);
  }

  public void publishInvoice(String payload) {
    jms.convertAndSend("queue.billing", payload);
  }

  /** The topic is only known at run time. */
  public void publishDynamic(String topic, String payload) {
    kafka.send(topic, payload);
  }
}
