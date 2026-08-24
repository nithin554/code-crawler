package com.acme;

/**
 * Entry point that wires the whole system together.
 */
public class Main {
    public static void main(String[] args) {
        OrderService orders = new OrderService();
        CustomerService customers = new CustomerService();
        ShippingService shipping = new ShippingService();

        Customer c = customers.find("alice");
        orders.place(c, "widget");
        shipping.ship(c);
    }
}
