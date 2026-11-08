package com.acme.wiring;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** The dominant modern style: one constructor, no @Autowired anywhere. */
@RestController
public class ConstructorInjectedController {
  private final GreetingService greetings;
  private final AuditService audit;

  public ConstructorInjectedController(GreetingService greetings, AuditService audit) {
    this.greetings = greetings;
    this.audit = audit;
  }

  @GetMapping("/hello")
  public String hello() {
    return greetings.greet();
  }
}
