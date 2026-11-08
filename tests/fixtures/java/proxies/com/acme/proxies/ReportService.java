package com.acme.proxies;

import org.springframework.cache.annotation.Cacheable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Another bean, so its calls reach OrderService through the proxy. */
@Service
public class ReportService {
    private final OrderService orders;

    public ReportService(OrderService orders) {
        this.orders = orders;
    }

    public void publish(String id) {
        orders.place(id);
    }

    @Cacheable("reports")
    public String build(String id) {
        return "report:" + id;
    }

    @Transactional
    public void recalculate(String id) {
        orders.place(id);
    }

    public void untouched() {}
}
