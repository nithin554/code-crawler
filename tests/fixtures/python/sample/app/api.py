"""HTTP surface (FastAPI-style)."""

from fastapi import APIRouter, Depends

from app.service import OrderService

router = APIRouter()


def get_service() -> OrderService:
    return OrderService()


@router.get("/orders/{order_id}")
def read_order(order_id: str, service: OrderService = Depends(get_service)) -> dict:
    return service.repo.find(order_id)


@router.post("/orders")
def create_order(order_id: str, amount: int, service: OrderService = Depends(get_service)) -> dict:
    return {"id": service.place(order_id, amount)}
