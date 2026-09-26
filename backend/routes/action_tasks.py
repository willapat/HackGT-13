from fastapi import APIRouter

from backend.routes.events import approve_task, respond

router = APIRouter()
router.add_api_route("/events/{event_id}/respond", respond, methods=["POST"])
router.add_api_route("/action_tasks/{task_id}/approve", approve_task, methods=["POST"])
