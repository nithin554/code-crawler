package com.acme.impact;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The changed class: injected into the controller, injects the repository, and
 * is advised by {@link TimingAspect}.
 */
@Service
public class OrderService {

  @Autowired private OrderRepository repository;

  @Transactional(readOnly = true)
  public String find(long id) {
    return repository.load(id);
  }

  public void evict() {
    repository.clear();
  }
}
