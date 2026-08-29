"""notification -- Slack webhook plus FCM push.

Notification failure must never fail a workflow: an approver not getting a
Slack ping is an operational annoyance, not a reason to abandon a purchase
order. Every channel is attempted independently and the per-channel outcome is
returned so the trace records exactly what was and was not delivered.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

import structlog

from app.agent.tools.base import Tool, ToolContext
from app.core.config import settings

log = structlog.get_logger(__name__)

NotificationKind = Literal[
    "approval_required",
    "approval_decided",
    "po_issued",
    "workflow_escalated",
    #: A buyer is asking vendors to quote, because nothing in the catalog
    #: matched or nothing came in under budget. Goes to vendors.
    "quote_requested",
    #: A vendor answered. Goes back to the buyer who asked.
    "quote_received",
    #: The buyer closed out a purchase order. Goes to the supplier.
    "po_closed",
]


@dataclass(slots=True)
class NotificationPayload:
    kind: NotificationKind
    title: str
    body: str
    #: FCM registration tokens of the users who should be pushed.
    fcm_tokens: list[str] = field(default_factory=list)
    #: Deep-link target, e.g. "agentflow://approvals/<id>".
    deep_link: str | None = None
    data: dict[str, Any] = field(default_factory=dict)
    slack_enabled: bool = True


@dataclass(slots=True)
class ChannelResult:
    channel: str
    ok: bool
    detail: str
    recipients: int = 0


@dataclass(slots=True)
class NotificationResult:
    channels: list[ChannelResult]

    @property
    def any_delivered(self) -> bool:
        return any(c.ok for c in self.channels)

    @property
    def summary(self) -> str:
        return "; ".join(
            f"{c.channel}: {'ok' if c.ok else 'failed'} ({c.detail})"
            for c in self.channels
        )


async def send_slack(payload: NotificationPayload) -> ChannelResult:
    if not settings.slack_webhook_url:
        return ChannelResult("slack", False, "no webhook configured")

    import httpx

    blocks = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": payload.title[:150]},
        },
        {"type": "section", "text": {"type": "mrkdwn", "text": payload.body[:2900]}},
    ]
    if payload.deep_link:
        blocks.append(
            {
                "type": "context",
                "elements": [
                    {"type": "mrkdwn", "text": f"Open in AgentFlow: {payload.deep_link}"}
                ],
            }
        )

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                settings.slack_webhook_url,
                json={"text": payload.title, "blocks": blocks},
            )
        if response.status_code >= 300:
            return ChannelResult(
                "slack", False, f"HTTP {response.status_code}: {response.text[:120]}"
            )
    except Exception as exc:  # noqa: BLE001 - reported, never fatal
        return ChannelResult("slack", False, f"{type(exc).__name__}: {exc}")
    return ChannelResult("slack", True, "posted")


def _firebase_app():
    """Initialise the Firebase app once, tolerating repeat calls."""
    import json

    import firebase_admin
    from firebase_admin import credentials

    if firebase_admin._apps:  # noqa: SLF001 - documented module attribute
        return firebase_admin.get_app()

    raw = settings.firebase_credentials_json
    cred = (
        credentials.Certificate(json.loads(raw))
        if raw.strip().startswith("{")
        else credentials.Certificate(raw)
    )
    return firebase_admin.initialize_app(cred)


async def send_push(payload: NotificationPayload) -> ChannelResult:
    if not payload.fcm_tokens:
        return ChannelResult("fcm", False, "no device tokens")
    if not settings.firebase_credentials_json:
        return ChannelResult("fcm", False, "firebase credentials not configured")

    try:
        from firebase_admin import messaging
    except ImportError:  # pragma: no cover - dependency guard
        return ChannelResult("fcm", False, "firebase-admin not installed")

    try:
        _firebase_app()
        # Data values must all be strings for FCM.
        data = {k: str(v) for k, v in payload.data.items()}
        if payload.deep_link:
            data["deep_link"] = payload.deep_link

        message = messaging.MulticastMessage(
            tokens=payload.fcm_tokens[:500],
            notification=messaging.Notification(
                title=payload.title, body=payload.body
            ),
            data=data,
            android=messaging.AndroidConfig(priority="high"),
        )
        response = messaging.send_each_for_multicast(message)
    except Exception as exc:  # noqa: BLE001 - reported, never fatal
        return ChannelResult("fcm", False, f"{type(exc).__name__}: {exc}")

    return ChannelResult(
        "fcm",
        response.success_count > 0,
        f"{response.success_count} delivered, {response.failure_count} failed",
        recipients=response.success_count,
    )


class NotificationTool(Tool[NotificationPayload, NotificationResult]):
    name = "notification"
    description = (
        "Notify humans about an approval, decision, issued PO or escalation "
        "via Slack webhook and FCM push."
    )

    async def run(
        self, payload: NotificationPayload, ctx: ToolContext
    ) -> NotificationResult:
        if not settings.notifications_enabled:
            return NotificationResult(
                channels=[ChannelResult("all", False, "notifications disabled")]
            )

        channels: list[ChannelResult] = []
        if payload.slack_enabled:
            channels.append(await send_slack(payload))
        channels.append(await send_push(payload))

        result = NotificationResult(channels=channels)
        log.info(
            "notification.sent",
            kind=payload.kind,
            summary=result.summary,
            workflow_id=str(ctx.workflow_id),
        )
        return result
