from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, TypeAlias

from pydantic import BaseModel

JsonScalar: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonScalar | dict[str, "JsonValue"] | list["JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]


@dataclass(slots=True)
class Notification:
    method: str
    payload: JsonObject


@dataclass(slots=True)
class IncomingRequest:
    id: str | int
    method: str
    payload: JsonObject


class ServerInfo(BaseModel):
    name: str | None = None
    version: str | None = None


class InitializeResponse(BaseModel):
    serverInfo: ServerInfo | None = None


class SymbolEntry(BaseModel):
    """A single symbol from an outline (function, class, interface, type alias, enum)."""
    kind: Literal["function", "class", "interface", "type", "enum"]
    name: str
    line: int
    endLine: int
    children: list["SymbolEntry"] = []


class FileOutlineResult(BaseModel):
    """Outline result for a single file."""
    path: str
    symbols: list[SymbolEntry]

    @classmethod
    def from_event(cls, event: JsonObject) -> "FileOutlineResult":
        """Parse the structured outline from a ``tool/result`` session event.

        The plugin attaches the validated outline to the event's ``meta.outline``
        (via its ``presentationMeta`` hook), so programmatic consumers read the
        typed structure instead of parsing the rendered prose.
        """
        return cls.model_validate(_outline_from_event(event))


class DirectoryOutlineResult(BaseModel):
    """Outline result for a directory walk."""
    path: str
    files: list[FileOutlineResult]
    skippedFiles: int

    @classmethod
    def from_event(cls, event: JsonObject) -> "DirectoryOutlineResult":
        """Parse the structured outline from a ``tool/result`` session event.

        The plugin attaches the validated outline to the event's ``meta.outline``
        (via its ``presentationMeta`` hook), so programmatic consumers read the
        typed structure instead of parsing the rendered prose.
        """
        return cls.model_validate(_outline_from_event(event))


def _outline_from_event(event: JsonObject) -> JsonObject:
    """Extract the structured outline from a ``tool/result`` event.

    The event wraps the payload under ``data``, so ``meta`` is at ``data.meta``.
    """
    data = event.get("data")
    if isinstance(data, dict):
        meta = data.get("meta")
    else:
        meta = event.get("meta")
    if not isinstance(meta, dict):
        raise ValueError(
            "tool/result event has no 'meta' field — the runtime must attach "
            "the structured outline via presentationMeta (requires exec.parent "
            "to be undefined for LLM-driven calls)"
        )
    outline = meta.get("outline")
    if not isinstance(outline, dict):
        raise ValueError("tool/result event meta has no 'outline' field")
    return outline
