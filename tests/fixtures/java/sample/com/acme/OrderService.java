package com.acme;

public class OrderService {
    private final OrderRepository repo;

    public OrderService() {
        this.repo = new OrderRepository();
    }

    public Order place(Customer customer, String item) {
        Order order = repo.create(customer, item);
        repo.save(order);
        notify(customer);
        return order;
    }

    private void notify(Customer customer) {
        // no-op
    }
}
