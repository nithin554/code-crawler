package com.acme;

public class CustomerService {
    public Customer find(String name) {
        return new Customer(name);
    }
}
