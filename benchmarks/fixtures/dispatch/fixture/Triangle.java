package fixture;

/**
 * The dispatch target that is never constructed in {@link Main}, so a runtime log can prove
 * whether the graph over-approximates virtual dispatch.
 */
public final class Triangle implements Shape {
  private final double base;
  private final double height;

  public Triangle(double base, double height) {
    this.base = base;
    this.height = height;
  }

  @Override
  public double area() {
    System.out.println("[call] fixture.Triangle.area");
    return 0.5 * this.base * this.height;
  }
}
