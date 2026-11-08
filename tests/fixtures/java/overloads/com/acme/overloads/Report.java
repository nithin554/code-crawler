package com.acme.overloads;

/** Overloaded constructors, chosen by argument type or not at all. */
public class Report {
  private final String label;

  public Report(int size) {
    this.label = "size=" + size;
  }

  public Report(String name) {
    this.label = name;
  }

  public String label() {
    return label;
  }
}
