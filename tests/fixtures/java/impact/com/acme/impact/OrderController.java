package com.acme.impact;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The entry point: a route reaches the service through a field injection.
 */
@RestController
@RequestMapping("/orders")
public class OrderController {

  @Autowired private OrderService orderService;

  @GetMapping("/{id}")
  public String show(long id) {
    return orderService.find(id);
  }
}
