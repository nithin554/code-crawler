"""Domain services."""

from __future__ import annotations

from injection import injectable

from app.repository import OrderRepository

AUDIT_LOG: list[str] = []


@injectable
class OrderService:
    """Places orders using an injected repository."""

    def __init__(self, repo: OrderRepository) -> None:
        self.repo = repo

    def place(self, order_id: str, amount: int) -> str:
        created = self.repo.create(order_id, amount)
        self.audit(created)
        return created

    def audit(self, order_id: str) -> None:
        AUDIT_LOG.append(order_id)
