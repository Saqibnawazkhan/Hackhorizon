"""Import-job persistence.

An import is deliberately two calls: upload parses and stores every row with
its verdict, commit writes the approved subset to the catalog. Keeping the
parsed rows in the database between the two means the preview a vendor
approved is exactly what gets committed -- the file is never re-parsed, so a
re-upload cannot quietly change what they agreed to.
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Sequence
from uuid import UUID

from sqlalchemy import func, select

from app.db.models import ImportJob, ImportJobRow
from app.repositories.base import BaseRepository
from app.schemas.enums import ImportJobStatus


class ImportJobRepository(BaseRepository[ImportJob]):
    model = ImportJob

    async def create_job(
        self,
        *,
        vendor_id: UUID,
        created_by: UUID | None,
        filename: str,
        mapping: list[dict[str, str]],
        total_rows: int,
        rows_missing_terms: int,
    ) -> ImportJob:
        job = ImportJob(
            vendor_id=vendor_id,
            created_by=created_by,
            filename=filename,
            status=ImportJobStatus.PREVIEWED.value,
            mapping_json=mapping,
            total_rows=total_rows,
            rows_missing_terms=rows_missing_terms,
        )
        self.session.add(job)
        await self.session.flush()
        return job

    async def add_rows(
        self, job_id: UUID, rows: Sequence[dict[str, Any]]
    ) -> Sequence[ImportJobRow]:
        models = [
            ImportJobRow(
                import_job_id=job_id,
                row_number=r["row_number"],
                raw_json=r["raw"],
                parsed_json=r.get("parsed"),
                errors_json=r.get("errors", []),
                is_duplicate_sku=r.get("is_duplicate_sku", False),
            )
            for r in rows
        ]
        self.session.add_all(models)
        await self.session.flush()
        return models

    async def for_vendor(
        self, vendor_id: UUID, *, limit: int = 20
    ) -> Sequence[ImportJob]:
        return (
            await self.session.scalars(
                select(ImportJob)
                .where(ImportJob.vendor_id == vendor_id)
                .order_by(ImportJob.created_at.desc())
                .limit(limit)
            )
        ).all()

    async def owned_by(self, job_id: UUID, vendor_id: UUID) -> ImportJob | None:
        """Scoped fetch. A vendor must never load another vendor's job."""
        return await self.session.scalar(
            select(ImportJob).where(
                ImportJob.id == job_id, ImportJob.vendor_id == vendor_id
            )
        )

    async def rows_for(
        self, job_id: UUID, *, row_numbers: Sequence[int] | None = None
    ) -> Sequence[ImportJobRow]:
        stmt = (
            select(ImportJobRow)
            .where(ImportJobRow.import_job_id == job_id)
            .order_by(ImportJobRow.row_number)
        )
        if row_numbers is not None:
            stmt = stmt.where(ImportJobRow.row_number.in_(list(row_numbers)))
        return (await self.session.scalars(stmt)).all()

    async def count_rows(self, job_id: UUID) -> int:
        return int(
            await self.session.scalar(
                select(func.count())
                .select_from(ImportJobRow)
                .where(ImportJobRow.import_job_id == job_id)
            )
            or 0
        )

    async def mark_committed(
        self,
        job: ImportJob,
        *,
        committed: int,
        failed: int,
        created: int,
        updated: int,
        rows_missing_terms: int | None = None,
        mapping: list[dict[str, str]] | None = None,
    ) -> ImportJob:
        job.status = (
            ImportJobStatus.COMMITTED.value
            if failed == 0
            else ImportJobStatus.PARTIALLY_COMMITTED.value
        )
        job.committed_rows = committed
        job.failed_rows = failed
        job.created_rows = created
        job.updated_rows = updated
        job.committed_at = datetime.now(UTC)
        if rows_missing_terms is not None:
            # At preview this counted every row without terms, invalid ones
            # included. Only the rows that actually landed can need terms
            # filling in, so the commit narrows it.
            job.rows_missing_terms = rows_missing_terms
        if mapping is not None:
            job.mapping_json = mapping
        await self.session.flush()
        return job

    async def mark_failed(self, job: ImportJob, error: str) -> ImportJob:
        job.status = ImportJobStatus.FAILED.value
        job.error = error
        await self.session.flush()
        return job


__all__ = ["ImportJobRepository"]
