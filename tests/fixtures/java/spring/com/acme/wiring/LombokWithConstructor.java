package com.acme.wiring;

import lombok.AllArgsConstructor;
import org.springframework.stereotype.Service;

/**
 * A hand-written constructor plus a generated one is two constructors, so
 * Spring cannot choose and nothing is injected. Reporting the field as an
 * injection here would be a duplicate of a dependency that never arrives.
 */
@Service
@AllArgsConstructor
public class LombokWithConstructor {
  private final GreetingService greetings;
  private final AuditService audit;

  public LombokWithConstructor() {
    this.greetings = null;
    this.audit = null;
  }
}
