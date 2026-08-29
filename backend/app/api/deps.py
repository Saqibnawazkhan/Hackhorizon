"""FastAPI dependencies: auth, role guards, pagination.

Identity comes from a Supabase Auth JWT. This layer verifies it and resolves
the caller's role, org and (for vendors) the vendor profile they own. The role
guards below are the API-side half of the isolation rules; the RLS policies in
``migrations/002_rls.sql`` are the database-side half. Both exist because the
backend connects as service_role and therefore bypasses RLS.
"""
from __future__ import annotations

from time import monotonic
from time import monotonic
from typing import Annotated
from uuid import UUID

import jwt
import structlog
from fastapi import Depends, HTTPException, Query, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.session import get_session
from app.schemas.auth import CurrentUser
from app.schemas.enums import UserRole

log = structlog.get_logger(__name__)

bearer = HTTPBearer(auto_error=False)

SessionDep = Annotated[AsyncSession, Depends(get_session)]


def _unauthorised(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


_jwks_client: jwt.PyJWKClient | None = None


def _get_jwks_client() -> jwt.PyJWKClient:
    """Cached JWKS client.

    Supabase signs access tokens with rotating asymmetric keys (ES256) and
    publishes them at the project's JWKS URL. PyJWKClient caches the key set
    and refetches on an unknown ``kid``, so a key rotation needs no redeploy.
    """
    global _jwks_client
    if _jwks_client is None:
        _jwks_client = jwt.PyJWKClient(
            settings.jwks_url,
            cache_keys=True,
            lifespan=settings.jwks_cache_seconds,
        )
    return _jwks_client


def decode_supabase_jwt(token: str) -> dict:
    """Verify a Supabase access token and return its claims.

    Tries the asymmetric path first (the current default), falling back to the
    legacy HS256 shared secret for a project that has not rotated yet.
    """
    common = {
        "audience": "authenticated",
        "options": {"verify_exp": True},
        # Tolerate clock skew between this host and Supabase. Without it a
        # freshly minted token can be rejected as "not yet valid (iat)" on a
        # machine whose clock runs slightly behind.
        "leeway": settings.jwt_leeway_seconds,
    }

    if settings.supabase_url:
        try:
            key = _get_jwks_client().get_signing_key_from_jwt(token)
            return jwt.decode(
                token, key.key, algorithms=["ES256", "RS256"], **common
            )
        except jwt.ExpiredSignatureError:
            raise _unauthorised("token has expired") from None
        except jwt.PyJWKClientError as exc:
            # No matching key -- fall through to the legacy secret if present.
            log.debug("jwks.miss", error=str(exc))
        except jwt.InvalidTokenError as exc:
            if not settings.supabase_jwt_secret:
                raise _unauthorised(f"invalid token: {exc}") from None

    if settings.supabase_jwt_secret:
        try:
            return jwt.decode(
                token, settings.supabase_jwt_secret, algorithms=["HS256"], **common
            )
        except jwt.ExpiredSignatureError:
            raise _unauthorised("token has expired") from None
        except jwt.InvalidTokenError as exc:
            raise _unauthorised(f"invalid token: {exc}") from None

    raise _unauthorised(
        "cannot verify tokens: set SUPABASE_URL (for JWKS) or "
        "SUPABASE_JWT_SECRET (legacy HS256)"
    )


#: user id -> (resolved identity, monotonic expiry).
#:
#: Every authenticated request resolved the caller with a SELECT on users, and
#: a second on vendors for a vendor role. That is one to two round trips of
#: ~200 ms on the front of EVERY endpoint, re-reading a row that almost never
#: changes -- and a screen making six calls paid it six times.
#:
#: The TTL is the ceiling on how long a role or org change takes to bite.
_identity_cache: dict[UUID, tuple[CurrentUser, float]] = {}
_IDENTITY_TTL_SECONDS = 60.0


def invalidate_identity(user_id: UUID) -> None:
    """Drop a cached identity. Call after changing a user's role or org."""
    _identity_cache.pop(user_id, None)


async def _resolve_user(claims: dict, session: AsyncSession) -> CurrentUser:
    """Build the CurrentUser from claims, backfilling from the users table.

    Role is read from the JWT when Supabase has been configured to include it,
    and from ``public.users`` otherwise. The users row is authoritative when
    the two disagree -- a token minted before a role change must not grant the
    old role.
    """
    from sqlalchemy import select

    from app.db.models import User, Vendor

    user_id = UUID(claims["sub"])

    cached = _identity_cache.get(user_id)
    if cached is not None and cached[1] > monotonic():
        return cached[0]

    row = await session.scalar(select(User).where(User.id == user_id))

    metadata = claims.get("app_metadata") or {}
    role_claim = metadata.get("role") or claims.get("role")

    if row is not None:
        role = UserRole(row.role)
        org_id = row.org_id
        full_name = row.full_name
        email = row.email
    else:
        # The mirror trigger has not fired yet (or RLS hid the row).
        try:
            role = UserRole(role_claim) if role_claim else UserRole.EMPLOYEE
        except ValueError:
            role = UserRole.EMPLOYEE
        org_id, full_name = None, None
        email = claims.get("email")

    vendor_id = None
    if role is UserRole.VENDOR:
        vendor_id = await session.scalar(
            select(Vendor.id).where(Vendor.user_id == user_id)
        )

    identity = CurrentUser(
        id=user_id,
        email=email,
        role=role,
        org_id=org_id,
        vendor_id=vendor_id,
        full_name=full_name,
    )
    _identity_cache[user_id] = (identity, monotonic() + _IDENTITY_TTL_SECONDS)
    return identity


# --------------------------------------------------------------------------
# Identity cache
#
# _resolve_user reads public.users (and, for a vendor, the vendors row) on
# every single request. Against an out-of-region Supabase project that is a
# full round trip -- ~200ms -- spent re-learning something that changes maybe
# once a month.
#
# What is cached is ONLY the database lookup. decode_supabase_jwt still runs
# on every request, so an expired, forged or revoked-signature token is
# rejected exactly as before; the cache is keyed on the token's subject and
# cannot be reached without first presenting a valid signature. The TTL is
# short so a role change takes effect promptly rather than at token expiry.
# --------------------------------------------------------------------------
_identity_cache: dict[str, tuple[float, CurrentUser]] = {}


def _cached_identity(sub: str) -> CurrentUser | None:
    ttl = settings.auth_identity_cache_seconds
    if ttl <= 0:
        return None
    entry = _identity_cache.get(sub)
    if entry is None:
        return None
    cached_at, user = entry
    if monotonic() - cached_at > ttl:
        _identity_cache.pop(sub, None)
        return None
    return user


def _store_identity(sub: str, user: CurrentUser) -> None:
    if settings.auth_identity_cache_seconds <= 0:
        return
    # Unbounded growth is not a real risk at this scale, but a runaway is
    # cheap to prevent and the entries are worthless once stale.
    if len(_identity_cache) > 2048:
        _identity_cache.clear()
    _identity_cache[sub] = (monotonic(), user)


def invalidate_identity(user_id: UUID | str) -> None:
    """Drop a cached identity, e.g. straight after a role change."""
    _identity_cache.pop(str(user_id), None)


async def get_current_user(
    request: Request,
    session: SessionDep,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)] = None,
) -> CurrentUser:
    token = credentials.credentials if credentials else None
    if not token:
        # WebSocket upgrades cannot set an Authorization header in the browser,
        # so a query-param token is accepted there and nowhere else.
        token = request.query_params.get("access_token")
    if not token:
        raise _unauthorised("missing bearer token")

    # Always verified, never cached.
    claims = decode_supabase_jwt(token)

    sub = str(claims.get("sub") or "")
    if sub:
        cached = _cached_identity(sub)
        if cached is not None:
            return cached

    user = await _resolve_user(claims, session)
    if sub:
        _store_identity(sub, user)
    return user


CurrentUserDep = Annotated[CurrentUser, Depends(get_current_user)]


def require_roles(*roles: UserRole):
    """Guard a route to specific roles."""

    async def _guard(user: CurrentUserDep) -> CurrentUser:
        if user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    f"this endpoint requires role "
                    f"{' or '.join(r.value for r in roles)}; you are {user.role.value}"
                ),
            )
        return user

    return _guard


require_admin = require_roles(UserRole.ADMIN)
require_vendor = require_roles(UserRole.VENDOR)
require_employee = require_roles(UserRole.EMPLOYEE)
require_buyer = require_roles(UserRole.EMPLOYEE, UserRole.ADMIN)

AdminDep = Annotated[CurrentUser, Depends(require_admin)]
VendorDep = Annotated[CurrentUser, Depends(require_vendor)]
BuyerDep = Annotated[CurrentUser, Depends(require_buyer)]


async def current_vendor_id(user: VendorDep) -> UUID:
    """The vendor profile the caller owns.

    Every vendor-scoped query is filtered by this value, which is derived from
    the authenticated identity and never from a client-supplied parameter --
    that is what stops a vendor reading a competitor's catalog through the API.
    """
    if user.vendor_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="no vendor profile is linked to this account",
        )
    return user.vendor_id


VendorIdDep = Annotated[UUID, Depends(current_vendor_id)]


class Pagination:
    def __init__(
        self,
        limit: int = Query(
            default=settings.default_page_size, ge=1, le=settings.max_page_size
        ),
        offset: int = Query(default=0, ge=0),
    ) -> None:
        self.limit = limit
        self.offset = offset


PaginationDep = Annotated[Pagination, Depends()]
