package com.acme.proxies;

import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;

/** Framework annotations that are not proxies: they are entry points or nothing. */
public class NotAService {
    @Scheduled(fixedRate = 1000)
    public void tick() {}

    @EventListener
    public void on(Object event) {}

    public void plain() {}
}
