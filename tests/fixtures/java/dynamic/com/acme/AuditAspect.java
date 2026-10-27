package com.acme;

import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.aspectj.lang.annotation.Before;
import org.aspectj.lang.annotation.Pointcut;

@Aspect
public class AuditAspect {
    @Pointcut("execution(* com.acme.*.pay(..))")
    public void paymentCall() {
    }

    @Around("paymentCall()")
    public Object auditPayment(ProceedingJoinPoint joinPoint) throws Throwable {
        return joinPoint.proceed();
    }

    @Before("execution(* com.acme.Checkout.checkout(..))")
    public void beforeCheckout() {
    }
}
