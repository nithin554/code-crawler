package com.acme.wiring;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

/** Two constructors, one of them annotated: only that one is injected. */
@Service
public class AutowiredChoice {
  private GreetingService greetings;
  private AuditService audit;

  public AutowiredChoice() {}

  @Autowired
  public AutowiredChoice(GreetingService greetings, AuditService audit) {
    this.greetings = greetings;
    this.audit = audit;
  }
}
