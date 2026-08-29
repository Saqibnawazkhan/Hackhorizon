"""Central configuration.

Every tunable in AgentFlow lives here and is overridable by environment
variable. Business logic must never hard-code a weight, threshold, timeout,
retry count or currency -- it reads it from ``settings``.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Annotated, Literal

from pydantic import Field, computed_field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class ScoringSettings(BaseSettings):
    """Default scoring weights (admin-configurable at runtime per org).

    These are the *fallback* values. ``scoring_weights`` rows in the database
    override them per organisation; see ScoringWeightsRepository.
    """

    model_config = SettingsConfigDict(env_prefix="SCORING_", extra="ignore")

    weight_price: float = Field(0.50, ge=0.0, le=1.0)
    weight_delivery: float = Field(0.30, ge=0.0, le=1.0)
    weight_warranty: float = Field(0.20, ge=0.0, le=1.0)
    # Reliability is available as a fourth criterion but defaults to 0 so the
    # demo matches the design: "Price 50% / Delivery 30% / Warranty 20%".
    weight_reliability: float = Field(0.00, ge=0.0, le=1.0)

    # Neutral normalised sub-score (0-1) applied when a vendor omits a field.
    # Never penalise silently, never auto-exclude -- see DATA CONFIDENCE.
    missing_field_neutral_score: float = Field(0.5, ge=0.0, le=1.0)
    # Reliability sub-score used for vendors with no fulfilment history.
    new_vendor_neutral_reliability: float = Field(0.5, ge=0.0, le=1.0)

    # Multi-item (MODE B) knobs.
    split_order_overhead_per_extra_po: float = Field(
        25_000.0,
        description="Administrative cost, in the workflow currency, charged "
        "against each PO beyond the first when evaluating a split scenario.",
    )
    split_lead_time_penalty_per_day: float = Field(
        0.5,
        description="Score points deducted per extra day of lead time that a "
        "split scenario incurs versus the fastest single-vendor scenario.",
    )
    min_coverage_ratio_to_consider: float = Field(
        0.0,
        ge=0.0,
        le=1.0,
        description="Vendors covering less than this fraction of line items "
        "are still shown but never selected as a single-vendor winner.",
    )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def weight_total(self) -> float:
        return round(
            self.weight_price
            + self.weight_delivery
            + self.weight_warranty
            + self.weight_reliability,
            6,
        )


class AgentSettings(BaseSettings):
    """Planner / orchestrator / tool execution tunables."""

    model_config = SettingsConfigDict(env_prefix="AGENT_", extra="ignore")

    model: str = Field("claude-sonnet-4-6", description="Anthropic model id.")
    max_tokens_planner: int = Field(2048, gt=0)
    max_tokens_justification: int = Field(1024, gt=0)
    temperature_planner: float = Field(0.0, ge=0.0, le=1.0)
    temperature_justification: float = Field(0.3, ge=0.0, le=1.0)

    # Planner re-prompts itself with the Pydantic validation error appended.
    planner_max_parse_attempts: int = Field(3, ge=1)

    # validate_po -> generate_po backward edge.
    max_self_correction_attempts: int = Field(2, ge=0)

    # Tool-level exponential backoff.
    tool_max_attempts: int = Field(3, ge=1)
    tool_backoff_base_seconds: float = Field(0.5, gt=0)
    tool_backoff_multiplier: float = Field(2.0, ge=1.0)
    tool_backoff_max_seconds: float = Field(8.0, gt=0)
    tool_timeout_seconds: float = Field(30.0, gt=0)

    llm_timeout_seconds: float = Field(60.0, gt=0)


class VendorMonitoringSettings(BaseSettings):
    """Thresholds for the background vendor-performance scanner."""

    model_config = SettingsConfigDict(env_prefix="VENDOR_", extra="ignore")

    late_delivery_grace_days: int = Field(0, ge=0)
    flag_after_late_deliveries: int = Field(2, ge=1)
    flag_below_on_time_rate: float = Field(0.80, ge=0.0, le=1.0)
    flag_after_cancellations: int = Field(2, ge=1)
    flag_below_quantity_accuracy: float = Field(0.95, ge=0.0, le=1.0)
    min_orders_for_reliability: int = Field(
        3, ge=1, description="Below this, a vendor reports: No history yet."
    )
    reliability_scan_interval_seconds: int = Field(3600, gt=0)
    low_stock_threshold: int = Field(20, ge=0)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # -- App ------------------------------------------------------------
    app_name: str = "AgentFlow"
    api_v1_prefix: str = "/api/v1"
    environment: Literal["local", "staging", "production"] = "local"
    debug: bool = False
    cors_origins: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["*"]
    )

    # -- Money ----------------------------------------------------------
    default_currency: str = Field("PKR", min_length=3, max_length=3)
    supported_currencies: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["PKR", "USD"]
    )

    # -- Supabase / Postgres --------------------------------------------
    # Populated once the Supabase project exists. Nothing at import time
    # requires them, so the app is buildable and testable before then.
    supabase_url: str = ""
    supabase_anon_key: str = ""
    supabase_service_role_key: str = ""
    supabase_project_ref: str = ""
    supabase_region: str = "ap-northeast-1"
    # Legacy HS256 shared secret. Supabase now signs with asymmetric keys
    # (ES256) by default and publishes them at the JWKS URL below; the shared
    # secret is only needed for a project still on the legacy key.
    supabase_jwt_secret: str = ""
    supabase_storage_bucket: str = "purchase-orders"
    signed_url_expiry_seconds: int = Field(3600, gt=0)
    jwks_cache_seconds: int = Field(3600, gt=0)
    # Clock-skew tolerance when verifying token iat/exp.
    jwt_leeway_seconds: int = Field(120, ge=0)

    database_url: str = ""
    # Supabase's session pooler caps a project at 15 client connections, and
    # LangGraph's checkpointer takes some of those. 4 + 4 leaves room for it
    # and for a second process (a worker, or a second dev machine).
    database_pool_size: int = Field(4, gt=0)
    database_max_overflow: int = Field(4, ge=0)
    database_echo: bool = False
    # A liveness `SELECT 1` on every pool checkout. That is a full round trip,
    # so against an out-of-region Supabase project it is ~200ms on every
    # request. ``pool_recycle`` already retires connections inside Supabase's
    # idle timeout, so this defaults off; turn it on for a pooler that drops
    # connections earlier than expected.
    database_pool_pre_ping: bool = False

    # How long a verified access token's resolved identity is reused before
    # the users row is read again. Every authenticated request otherwise costs
    # one extra round trip just to learn the caller's role and org. The JWT
    # signature is ALWAYS verified regardless -- only the database lookup is
    # cached -- so this cannot let an expired or forged token through. Kept
    # short so a role change takes effect promptly; set 0 to disable.
    auth_identity_cache_seconds: int = Field(30, ge=0)

    # LangGraph PostgresSaver. Defaults to database_url when unset.
    checkpointer_database_url: str = ""

    # -- Anthropic ------------------------------------------------------
    anthropic_api_key: str = ""
    # Identity-linked API keys (sk-ant-api03-... issued against a user
    # identity rather than a workspace) must name the workspace each request
    # acts in, or the API returns 400. Console > Settings > Workspaces.
    # Leave blank for a classic workspace-scoped key.
    anthropic_workspace_id: str = ""

    # -- Notifications --------------------------------------------------
    slack_webhook_url: str = ""
    firebase_credentials_json: str = ""
    notifications_enabled: bool = True

    # -- Imports --------------------------------------------------------
    import_max_rows: int = Field(5000, gt=0)
    import_max_file_bytes: int = Field(5 * 1024 * 1024, gt=0)

    # -- WebSocket ------------------------------------------------------
    ws_heartbeat_seconds: int = Field(25, gt=0)
    ws_replay_buffer_size: int = Field(500, gt=0)

    # -- Pagination -----------------------------------------------------
    default_page_size: int = Field(20, gt=0, le=200)
    max_page_size: int = Field(100, gt=0, le=500)

    # -- Nested ---------------------------------------------------------
    scoring: ScoringSettings = Field(default_factory=ScoringSettings)
    agent: AgentSettings = Field(default_factory=AgentSettings)
    vendor: VendorMonitoringSettings = Field(default_factory=VendorMonitoringSettings)

    @field_validator("cors_origins", "supported_currencies", mode="before")
    @classmethod
    def _split_csv(cls, v: object) -> object:
        if isinstance(v, str):
            return [part.strip() for part in v.split(",") if part.strip()]
        return v

    @computed_field  # type: ignore[prop-decorator]
    @property
    def effective_checkpointer_url(self) -> str:
        return self.checkpointer_database_url or self.database_url

    @staticmethod
    def _is_real(value: str) -> bool:
        """Reject blanks and the ``xxxx`` placeholders shipped in .env.example."""
        return bool(value) and "xxxx" not in value.lower()

    @computed_field  # type: ignore[prop-decorator]
    @property
    def supabase_configured(self) -> bool:
        return self._is_real(self.supabase_url) and self._is_real(
            self.supabase_service_role_key
        )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def database_configured(self) -> bool:
        return self._is_real(self.database_url)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def project_ref(self) -> str:
        """Derive the project ref from the URL when it was not set explicitly."""
        if self.supabase_project_ref:
            return self.supabase_project_ref
        if self.supabase_url:
            return (
                self.supabase_url.removeprefix("https://")
                .removeprefix("http://")
                .split(".", 1)[0]
            )
        return ""

    @computed_field  # type: ignore[prop-decorator]
    @property
    def jwks_url(self) -> str:
        return f"{self.supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"

    @computed_field  # type: ignore[prop-decorator]
    @property
    def auth_configured(self) -> bool:
        """Either asymmetric (JWKS) or the legacy shared secret will do."""
        return bool(self.supabase_url) or self._is_real(self.supabase_jwt_secret)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def anthropic_configured(self) -> bool:
        return self._is_real(self.anthropic_api_key)


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
