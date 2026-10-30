package com.acme;

/** Declares its own accessor, so no implicit one must be synthesized. */
public record Label(String text, int weight) {
  public String text() {
    return text.trim();
  }

  public static Label of(String text) {
    return new Label(text, 1);
  }
}
