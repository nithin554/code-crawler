package com.acme.proxies;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** A final class cannot be subclassed, so CGLIB cannot wrap it at all. */
@Service
@Transactional
public final class SealedService {
    public void run() {}
}
