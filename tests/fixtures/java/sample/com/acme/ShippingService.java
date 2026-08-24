package com.acme;

public class ShippingService {
    public void ship(Customer customer) {
        Tracking tracking = new Tracking(customer);
        tracking.dispatch();
    }
}
