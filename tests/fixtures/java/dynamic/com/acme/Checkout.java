package com.acme;

public class Checkout {
    private final Payment payment;

    public Checkout(Payment payment) {
        this.payment = payment;
    }

    public void checkout(double amount) {
        payment.pay(amount);
    }
}
