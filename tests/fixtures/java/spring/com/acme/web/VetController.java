package com.acme.web;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * An unrooted class prefix, a bare verb annotation that inherits it, and a path
 * that is not a plain identifier.
 */
@RestController
@RequestMapping("vets")
public class VetController {

  @GetMapping
  public String list() {
    return null;
  }

  @GetMapping("/vets.html")
  public String html() {
    return null;
  }
}
