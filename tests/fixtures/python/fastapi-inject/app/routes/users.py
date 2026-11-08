from fastapi import APIRouter, Depends

from app.deps import CurrentUser, SessionDep
from app.models import Item

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/")
def read_users(session: SessionDep) -> list[Item]:
    """`SessionDep` is an imported alias, not a type this file can see."""
    return []


@router.get("/me")
def read_me(current_user: CurrentUser) -> Item:
    return Item(title=current_user.email)


@router.get("/{item_id}")
def read_item(item_id: int, item: Item) -> Item:
    """Numbers and project types are not dependencies; this must stay empty."""
    return item