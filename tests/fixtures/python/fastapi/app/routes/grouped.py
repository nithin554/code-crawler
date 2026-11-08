from fastapi import APIRouter

# Two groups in one module: only routes declared on a prefixed group move.
users = APIRouter(prefix="/users")
plain = APIRouter(tags=["plain"])

# Not a route group at all, even though it takes a `prefix` keyword.
settings = AppFactory(prefix="/config", tags=["config"])


@users.get("/me")
def read_me() -> dict:
    return {}


@plain.get("/ping")
def ping() -> dict:
    return {"ping": True}
