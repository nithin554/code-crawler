package com.acme;

public class CardPayment implements Payment {
    @Override
    public void pay(double amount) {
        authorize(amount);
    }

    private void authorize(double amount) {
        System.out.println(amount);
    }
}
