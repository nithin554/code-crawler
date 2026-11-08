package com.acme.impact;

import org.springframework.stereotype.Repository;

@Repository
public class OrderRepository {

  public String load(long id) {
    return "order-" + id;
  }

  public void clear() {
  }
}
