package fixture;

/**
 * Exercises virtual dispatch through the {@link Shape} interface.
 *
 * <p>Each implementation prints a line when its method runs, so the program's own output is the
 * ground truth for which dispatch targets actually execute. {@link Triangle} is declared but never
 * constructed, which makes it a probe for over-approximation: if the graph claims an edge to
 * Triangle, that edge is plausible but unproven by this run.
 */
public final class Main {
  private static String describe(Shape shape) {
    System.out.println("[dispatch] fixture.Main.describe -> " + shape.getClass().getName());
    return shape.getClass().getSimpleName() + ".area=" + shape.area();
  }

  public static void main(String[] args) {
    Shape circle = new Circle(1.0);
    Shape square = new Square(2.0);
    System.out.println("result " + describe(circle));
    System.out.println("result " + describe(square));
  }

  private Main() {}
}
