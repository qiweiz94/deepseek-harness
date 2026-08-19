from __future__ import annotations

import asyncio
import uuid
from typing import Callable

from .api import (
    DeepSeekHarness,
    DeepSeekHarnessConfig,
    RunResult,
    final_response,
    finish_reason,
    normalize_input,
)
from .models import JsonObject, Notification


class AsyncSession:
    """Async session handle for running agent turns."""

    def __init__(self, harness: AsyncDeepSeekHarness, session_id: str) -> None:
        self.harness = harness
        self.id = session_id

    async def run(
        self,
        input: str | list[JsonObject],
        *,
        on_notification: Callable[[Notification], None] | None = None,
    ) -> RunResult:
        """Run an agent turn asynchronously."""
        content_blocks = normalize_input(input)
        notifications: list[Notification] = []
        events: list[JsonObject] = []

        def collect(notification: Notification) -> None:
            notifications.append(notification)
            if on_notification is not None:
                on_notification(notification)
            if (
                notification.method == "session.event"
                and notification.payload.get("sessionId") == self.id
            ):
                event = notification.payload.get("event")
                if isinstance(event, dict):
                    events.append(event)

        def _run_sync() -> RunResult:
            with self.harness._sync.client.subscribe_session_notifications(self.id) as subscription:
                message_id = self.harness._sync.client.session_prompt(
                    self.id,
                    content_blocks,
                    notification_subscription=subscription,
                )

                received = False
                while True:
                    notification = subscription.next()
                    if not received:
                        from .api import _is_inbox_receipt
                        if not _is_inbox_receipt(notification, self.id, message_id):
                            continue
                        received = True
                    collect(notification)
                    if (
                        notification.method == "session.status"
                        and notification.payload.get("sessionId") == self.id
                        and notification.payload.get("status") == "idle"
                    ):
                        break

            return RunResult(
                session_id=self.id,
                final_response=final_response(events),
                finish_reason=finish_reason(events),
                events=events,
                notifications=notifications,
                session_root=self.harness._sync.config.session_root,
            )

        return await asyncio.to_thread(_run_sync)


class AsyncDeepSeekHarness:
    """Async wrapper for DeepSeekHarness.

    Runs synchronous operations in a thread pool to avoid blocking the event loop.
    """

    def __init__(self, config: DeepSeekHarnessConfig | None = None, **kwargs: object) -> None:
        self._sync = DeepSeekHarness(config, **kwargs)

    async def __aenter__(self) -> AsyncDeepSeekHarness:
        await self.start()
        return self

    async def __aexit__(self, _exc_type, _exc, _tb) -> None:
        await self.close()

    async def start(self) -> None:
        """Start the runtime subprocess asynchronously."""
        await asyncio.to_thread(self._sync.start)

    async def close(self) -> None:
        """Close the runtime subprocess asynchronously."""
        await asyncio.to_thread(self._sync.close)

    async def start_session(self, session_id: str | None = None) -> AsyncSession:
        """Start a new session asynchronously."""
        await self.start()
        return AsyncSession(self, session_id or f"session-{uuid.uuid4().hex}")

    async def run(
        self,
        input: str | list[JsonObject],
        *,
        session_id: str | None = None,
        on_notification: Callable[[Notification], None] | None = None,
    ) -> RunResult:
        """Run an agent turn asynchronously."""
        session = await self.start_session(session_id)
        return await session.run(input, on_notification=on_notification)
