"""Auth schemas.

Identity is Supabase Auth. FastAPI verifies the JWT and reads the role claim;
it never issues its own tokens. The login endpoints are thin proxies so the
Flutter app has one base URL, and so role resolution happens in exactly one
place.
"""
from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import EmailStr, Field

from app.schemas.common import AppModel, Identified
from app.schemas.enums import UserRole


class LoginRequest(AppModel):
    email: EmailStr
    password: str = Field(..., min_length=6, max_length=200)


class SignupRequest(LoginRequest):
    full_name: str = Field(..., min_length=1, max_length=140)
    role: UserRole = Field(
        UserRole.EMPLOYEE,
        description="Vendor self-signup lands as VENDOR with a PENDING vendor row.",
    )
    vendor_name: str | None = Field(
        None, max_length=200, description="Required when role is vendor."
    )


class UserRead(Identified):
    email: str
    full_name: str | None
    role: UserRole
    org_id: UUID | None
    vendor_id: UUID | None = Field(
        None, description="Set only for vendor-role users."
    )
    avatar_initials: str | None = None
    created_at: datetime


class TokenResponse(AppModel):
    access_token: str
    refresh_token: str | None = None
    token_type: str = "bearer"
    expires_in: int | None = None
    expires_at: datetime | None = None
    user: UserRead


class RefreshRequest(AppModel):
    refresh_token: str


class CurrentUser(AppModel):
    """Resolved from the verified JWT and injected into every protected route."""

    id: UUID
    email: str | None
    role: UserRole
    org_id: UUID | None
    vendor_id: UUID | None = None
    full_name: str | None = None

    @property
    def is_admin(self) -> bool:
        return self.role is UserRole.ADMIN

    @property
    def is_vendor(self) -> bool:
        return self.role is UserRole.VENDOR

    @property
    def is_employee(self) -> bool:
        return self.role is UserRole.EMPLOYEE


class FcmTokenRegister(AppModel):
    token: str = Field(..., min_length=10, max_length=500)
    platform: str = Field("android", max_length=20)
    device_id: str | None = Field(None, max_length=200)
