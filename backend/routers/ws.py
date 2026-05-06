import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from ..websocket_manager import manager
from ..scheduler import get_last_payload

log = logging.getLogger(__name__)
router = APIRouter()


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        # Send the last known snapshot immediately on connect
        last = get_last_payload()
        if last:
            import json
            await websocket.send_text(json.dumps(last, default=str))
        # Keep the connection alive
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.debug(f"WS error: {e}")
    finally:
        manager.disconnect(websocket)
