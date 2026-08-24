package com.acme;

public class Tracking {
    private final Customer customer;

    public Tracking(Customer customer) {
        this.customer = customer;
    }

    public void dispatch() {
        System.out.println("dispatching for " + customer.getName());
    }
}
