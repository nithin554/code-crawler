package com.acme.wiring;

import org.springframework.stereotype.Service;

@Service
public class GreetingService {
  public String greet() {
    return "hello";
  }
}
