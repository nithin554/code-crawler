package fixture;

public final class Circle implements Shape {
  private final double radius;

  public Circle(double radius) {
    this.radius = radius;
  }

  @Override
  public double area() {
    System.out.println("[call] fixture.Circle.area");
    return Math.PI * this.radius * this.radius;
  }
}
