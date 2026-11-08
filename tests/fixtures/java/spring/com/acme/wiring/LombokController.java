package com.acme.wiring;

import java.util.HashMap;
import java.util.Map;
import lombok.AllArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.RestController;

/** All-arguments constructor generated at compile time; none in the source. */
@RestController
@AllArgsConstructor
public class LombokController {
  private static final Logger LOG = LoggerFactory.getLogger(LombokController.class);
  private final GreetingService greetings;
  private final AuditService audit;
  private final Map<String, String> cache = new HashMap<>();

  public String hello() {
    return greetings.greet();
  }
}
