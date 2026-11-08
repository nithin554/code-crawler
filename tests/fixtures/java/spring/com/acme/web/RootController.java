package com.acme.web;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** No class-level prefix at all, and the root path. */
@RestController
public class RootController {

  @GetMapping("/")
  public String index() {
    return null;
  }
}
