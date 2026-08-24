package com.acme;

public class OrderRepository {
    public Order create(Customer customer, String item) {
        return new Order(customer, item);
    }

    public void save(Order order) {
        // no-op
    }
}
