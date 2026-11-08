package com.acme.wiring;

import lombok.AllArgsConstructor;

/** Lombok without a container: the constructor exists, but nobody injects into it. */
@AllArgsConstructor
public class NonBeanLombok {
  private final GreetingService greetings;
}
