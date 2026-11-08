from fastapi import APIRouter

# No prefix: decorator paths are served exactly as written, trailing slash and all.
router = APIRouter(tags=["health"])


@router.get("/health-check/")
def health_check() -> dict:
    return {"status": "ok"}
