from fastapi import APIRouter

# Prefix keyword written after another keyword: argument order must not matter.
router = APIRouter(tags=["private"], prefix="/private")


@router.post("/users/")
def create_private_user() -> dict:
    return {}
