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


class DirectoryOutlineResult(BaseModel):
    """Outline result for a directory walk."""
    path: str
    files: list[FileOutlineResult]
    skippedFiles: int
