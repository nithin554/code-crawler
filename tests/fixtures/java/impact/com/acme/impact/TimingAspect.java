package com.acme.impact;

import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;

@Aspect
public class TimingAspect {

  @Around("execution(* com.acme.impact.OrderService.find(..))")
  public Object time(ProceedingJoinPoint joinPoint) throws Throwable {
    return joinPoint.proceed();
  }
}
