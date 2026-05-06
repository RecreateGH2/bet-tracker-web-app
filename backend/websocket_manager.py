import asyncio
import json
import logging
from fastapi import WebSocket

log = logging.getLogger(__name__)


class WebSocketManager:
    def __init__(self):
        self._connections: set[WebSocket] = set()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self._connections.add(websocket)
        log.info(f"WS connected. Total: {len(self._connections)}")

    def disconnect(self, websocket: WebSocket):
        self._connections.discard(websocket)
        log.info(f"WS disconnected. Total: {len(self._connections)}")

    async def broadcast(self, data: dict):
        if not self._connections:
            return
        message = json.dumps(data, default=str)
        dead = set()
        for ws in self._connections:
            try:
                await ws.send_text(message)
            except Exception:
                dead.add(ws)
        for ws in dead:
            self._connections.discard(ws)

    @property
    def connection_count(self) -> int:
        return len(self._connections)


manager = WebSocketManager()
