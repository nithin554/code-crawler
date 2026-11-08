from fastapi import APIRouter

router = APIRouter(prefix="/items", tags=["items"])


@router.get("/")
def read_items() -> list:
    return []


@router.get("/{item_id}")
def read_item(item_id: str) -> dict:
    return {}


@router.post("/")
def create_item(name: str) -> dict:
    return {"name": name}


@router.delete("/{item_id}")
def delete_item(item_id: str) -> bool:
    return True
