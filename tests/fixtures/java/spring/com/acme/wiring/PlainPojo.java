package com.acme.wiring;

/** Not a bean, so nothing constructs it through a container. */
public class PlainPojo {
  private final GreetingService greetings;

  public PlainPojo(GreetingService greetings) {
    this.greetings = greetings;
  }
}
