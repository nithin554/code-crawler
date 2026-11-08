package com.acme.overloads;

/** Same-arity overloads that a bare identifier cannot distinguish. */
public class Formatter {
  public String render(int value) {
    return Integer.toString(value);
  }

  public String render(String value) {
    return value;
  }

  public String ambiguous(Object input) {
    return render(input);
  }

  public String byInt() {
    return render(7);
  }

  public String byString() {
    return render("seven");
  }
}
