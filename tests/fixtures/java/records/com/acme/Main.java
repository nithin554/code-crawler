package com.acme;

public class Main {
  public static void main(String[] args) {
    Point point = new Point(3, 4);
    Label label = Label.of("tag");
    System.out.println(point.x() + point.sum() + label.weight());
  }
}
