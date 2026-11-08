package com.acme.proxies;

import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Class-level @Transactional: every method the container can override inherits it. */
@Service
@Transactional
public class OrderService {
    public void place(String id) {
        save(id);
        this.audit(id);
    }

    /** Self-invocation: the proxy is bypassed, so `place` is not transactional here. */
    public void retry(String id) {
        place(id);
    }

    public void save(String id) {}

    @Async
    private void audit(String id) {}

    static void reset() {}

    final void seal() {}
}
