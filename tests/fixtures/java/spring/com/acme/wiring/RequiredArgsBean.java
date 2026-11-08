package com.acme.wiring;

import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

/** Required-arguments constructor: final and @NonNull fields, unless initialised. */
@Service
@RequiredArgsConstructor
public class RequiredArgsBean {
  private final GreetingService greeting;
  private final AuditService initialised = new AuditService();
  private AuditService plain;
  @NonNull private AuditService required;
}
