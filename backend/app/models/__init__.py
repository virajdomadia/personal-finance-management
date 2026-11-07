"""Import every model module here so Alembic autogenerate sees it."""
from app.models.account import Account  # noqa: F401
from app.models.user import User  # noqa: F401
