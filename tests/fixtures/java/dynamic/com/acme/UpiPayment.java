package com.acme;

public class UpiPayment implements Payment {
    @Override
    public void pay(double amount) {
        settle(amount);
    }

    private void settle(double amount) {
        System.out.println(amount);
    }
}
