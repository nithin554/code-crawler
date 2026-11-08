from typing import Annotated

from fastapi import Depends
from sqlmodel import Session

from app.models import User


def get_db():
    with Session() as session:
        yield session


SessionDep = Annotated[Session, Depends(get_db)]


def get_current_user(session: SessionDep) -> User:
    """Nested: the alias resolves to `get_db` from inside a plain function."""
    return User(email="a@example.com")


CurrentUser = Annotated[User, Depends(get_current_user)]


def require_superuser(current_user: CurrentUser) -> User:
    return current_user