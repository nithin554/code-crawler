"""Executable entry point."""

from app.service import OrderService


def main() -> None:
    service = OrderService()
    service.place("o-1", 10)


if __name__ == "__main__":
    main()
