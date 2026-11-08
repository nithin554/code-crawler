package com.acme.wiring;

import org.springframework.stereotype.Service;

/**
 * Two constructors and no @Autowired: Spring cannot choose, so neither is an
 * injection point. Guessing one would be a confident wrong edge.
 */
@Service
public class TwoConstructorBean {
  private GreetingService greetings;

  public TwoConstructorBean() {}

  public TwoConstructorBean(GreetingService greetings) {
    this.greetings = greetings;
  }
}
