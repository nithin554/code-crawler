"""No framework import: an `Annotated` alias here is not a FastAPI dependency."""

from typing import Annotated

from sqlmodel import Session

from app.deps import SessionDep


def run(session: SessionDep) -> list[Session]:
    return [session]