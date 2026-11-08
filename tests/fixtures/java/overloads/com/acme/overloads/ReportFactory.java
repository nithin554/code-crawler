package com.acme.overloads;

/** Builds reports from arguments whose type the source does not pin down. */
public class ReportFactory {
  public Report fromValue(Object payload) {
    return new Report(payload);
  }

  public Report fromSize() {
    return new Report(3);
  }

  public String describe(Report report) {
    return report.label();
  }
}
