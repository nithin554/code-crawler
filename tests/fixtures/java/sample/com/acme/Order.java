package com.acme;

public class Order {
    private final Customer customer;
    private final String item;

    public Order(Customer customer, String item) {
        this.customer = customer;
        this.item = item;
    }
}
