package com.acme;

/** A 2-D point: components, compact constructor and a declared method. */
public record Point(int x, int y) implements Comparable<Point> {
  public Point {
    if (x < 0) throw new IllegalArgumentException("x");
  }

  public int sum() {
    return x + y;
  }

  @Override
  public int compareTo(Point other) {
    return sum() - other.sum();
  }
}
