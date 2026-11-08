from fastapi import APIRouter, Depends

from app.deps import require_superuser

router = APIRouter(prefix="/admin", tags=["admin"])


@router.post("/maintenance/", dependencies=[Depends(require_superuser)])
def start_maintenance() -> dict[str, bool]:
    """Guarded by a decorator-level dependency that no parameter names."""
    return {"started": True}