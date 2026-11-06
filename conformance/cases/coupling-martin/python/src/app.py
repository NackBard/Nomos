from __future__ import annotations

from typing import TYPE_CHECKING

from services import OrderService

if TYPE_CHECKING:
    from infra import SqlRepo


class Program:
    service = OrderService()
    repo: SqlRepo | None = None
