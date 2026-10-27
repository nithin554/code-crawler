"""Persistence layer."""


class OrderRepository:
    """Stores orders in memory."""

    def __init__(self, table: str = "orders") -> None:
        self.table = table
        self.rows: list[dict] = []

    def create(self, order_id: str, amount: int) -> str:
        if not order_id:
            raise ValueError("missing id")
        for row in self.rows:
            if row.get("id") == order_id:
                return row["id"]
        self.rows.append({"id": order_id, "amount": amount})
        return order_id

    def find(self, order_id: str) -> dict | None:
        return next((r for r in self.rows if r["id"] == order_id), None)
