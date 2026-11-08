package fixture;

public final class Square implements Shape {
  private final double side;

  public Square(double side) {
    this.side = side;
  }

  @Override
  public double area() {
    System.out.println("[call] fixture.Square.area");
    return this.side * this.side;
  }
}
