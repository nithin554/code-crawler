package com.acme.wiring;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/** Field injection still works, and its owner is the type. */
@Component
public class FieldInjectedService {
  @Autowired private GreetingService greeting;
}
