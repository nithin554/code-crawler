package com.acme.proxies;

import org.springframework.stereotype.Component;

/** Two hops from OrderService, so proxy facts stay off transitive rows. */
@Component
public class PublishJob {
    private final ReportService reports;

    public PublishJob(ReportService reports) {
        this.reports = reports;
    }

    public void run(String id) {
        reports.publish(id);
    }
}
