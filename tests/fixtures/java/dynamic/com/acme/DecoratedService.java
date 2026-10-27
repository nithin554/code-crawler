package com.acme;

import org.springframework.cache.annotation.Cacheable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class DecoratedService {
    @Transactional(readOnly = true)
    @Cacheable("orders")
    public String describe(String id) {
        return "order:" + id;
    }
}
