"""Spreadsheet import endpoints (vendor portal).

    GET  /imports/template      the target columns, and a starter CSV
    POST /imports/preview       upload -> parse, map, validate. Writes nothing.
    POST /imports/{id}/commit   write the approved rows to the catalog
    GET  /imports               this vendor's recent jobs
    GET  /imports/{id}          one job with its rows

Every route is scoped to the vendor profile derived from the token, never from
a client-supplied id, so one vendor cannot read or commit another's job.
"""
from __future__ import annotations

from typing import Any
from uuid import UUID

from fastapi import APIRouter, File, HTTPException, Response, UploadFile, status

from app.api.deps import SessionDep, VendorDep, VendorIdDep
from app.core.config import settings
from app.repositories.catalog_repo import CatalogRepository, VendorRepository
from app.repositories.import_repo import ImportJobRepository
from app.schemas.enums import ImportJobStatus
from app.schemas.imports import ImportCommitRequest
from app.services import import_service
from app.services.catalog_sources import CsvSource

router = APIRouter(prefix="/imports", tags=["imports"])


def _job_json(job) -> dict[str, Any]:
    # summary_line is a computed field on ImportJobRead. This handler builds
    # the dict itself, so it has to be computed here too or the response and
    # the documented schema disagree.
    summary = f"{job.committed_rows} of {job.total_rows} rows imported"
    if job.failed_rows:
        summary += f" · {job.failed_rows} skipped"
    return {
        "summary_line": summary,
        "id": str(job.id),
        "vendor_id": str(job.vendor_id),
        "filename": job.filename,
        "status": job.status,
        "total_rows": job.total_rows,
        "committed_rows": job.committed_rows,
        "failed_rows": job.failed_rows,
        "created_rows": job.created_rows,
        "updated_rows": job.updated_rows,
        "rows_missing_terms": job.rows_missing_terms,
        "error": job.error,
        "created_at": job.created_at.isoformat(),
        "committed_at": job.committed_at.isoformat() if job.committed_at else None,
    }


def _row_json(row) -> dict[str, Any]:
    parsed = row.parsed_json or {}
    return {
        "row_number": row.row_number,
        "raw": row.raw_json,
        "parsed": row.parsed_json,
        "errors": row.errors_json or [],
        "is_duplicate_sku": row.is_duplicate_sku,
        "missing_terms": [
            name
            for name in ("delivery_days", "warranty_months")
            if parsed.get(name) is None
        ],
        "committed": row.committed,
    }


# --------------------------------------------------------------------------
# Template
# --------------------------------------------------------------------------
@router.get("/template", summary="Target columns and a starter CSV")
async def get_template(_: VendorDep) -> dict[str, Any]:
    tpl = import_service.template()
    return {
        "filename": tpl.filename,
        "columns": [c.model_dump() for c in tpl.columns],
        "csv": import_service.template_csv(),
        "max_rows": settings.import_max_rows,
        "max_file_bytes": settings.import_max_file_bytes,
    }


@router.get("/template.csv", summary="Download the starter CSV")
async def download_template(_: VendorDep) -> Response:
    tpl = import_service.template()
    return Response(
        content=import_service.template_csv(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{tpl.filename}"'},
    )


# --------------------------------------------------------------------------
# Preview
# --------------------------------------------------------------------------
@router.post("/preview", summary="Upload, parse and validate. Writes nothing.")
async def preview(
    session: SessionDep,
    user: VendorDep,
    vendor_id: VendorIdDep,
    file: UploadFile = File(..., description="CSV or XLSX price list"),
) -> dict[str, Any]:
    content = await file.read()
    try:
        columns, raw_rows = import_service.parse_file(
            file.filename or "upload.csv", content
        )
    except import_service.ImportError_ as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc

    if not raw_rows:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The file has a header but no data rows.",
        )

    # Cap before validating: a vendor who uploads a 40k-row export gets the
    # first IMPORT_MAX_ROWS previewed and told so, rather than a timeout.
    truncated = len(raw_rows) > settings.import_max_rows
    if truncated:
        raw_rows = raw_rows[: settings.import_max_rows]

    mapping = import_service.suggest_mapping(columns)

    catalog = CatalogRepository(session)
    existing = await catalog.skus_for_vendor(vendor_id)
    verdicts = import_service.validate_rows(
        raw_rows, mapping, existing_skus=existing
    )

    jobs = ImportJobRepository(session)
    job = await jobs.create_job(
        vendor_id=vendor_id,
        created_by=user.id,
        filename=file.filename or "upload.csv",
        mapping=mapping,
        total_rows=len(verdicts),
        rows_missing_terms=sum(1 for v in verdicts if v["missing_terms"]),
    )
    await jobs.add_rows(job.id, verdicts)

    valid = sum(1 for v in verdicts if not v["errors"])
    return {
        "import_job_id": str(job.id),
        "filename": job.filename,
        "detected_columns": columns,
        "suggested_mapping": mapping,
        "unmapped_columns": [
            c for c in columns if all(m["source_column"] != c for m in mapping)
        ],
        "target_fields": [
            {
                "name": f.name,
                "required": f.required,
                "example": f.example,
                "note": f.note,
            }
            for f in import_service.TARGET_FIELDS
        ],
        "rows": verdicts,
        "total_rows": len(verdicts),
        "valid_rows": valid,
        "invalid_rows": len(verdicts) - valid,
        "duplicate_rows": sum(1 for v in verdicts if v["is_duplicate_sku"]),
        "rows_missing_terms": job.rows_missing_terms,
        "truncated": truncated,
    }


# --------------------------------------------------------------------------
# Commit
# --------------------------------------------------------------------------
@router.post("/{job_id}/commit", summary="Write the approved rows to the catalog")
async def commit(
    job_id: UUID,
    body: ImportCommitRequest,
    session: SessionDep,
    vendor_id: VendorIdDep,
) -> dict[str, Any]:
    jobs = ImportJobRepository(session)
    job = await jobs.owned_by(job_id, vendor_id)
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Import job not found."
        )
    if job.status in {
        ImportJobStatus.COMMITTED.value,
        ImportJobStatus.PARTIALLY_COMMITTED.value,
    }:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This import has already been committed.",
        )

    rows = await jobs.rows_for(job_id, row_numbers=body.row_numbers)
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No rows selected to import.",
        )

    # Re-validating against the stored mapping (or the edited one the client
    # sent) is what makes a corrected mapping take effect without a re-upload.
    mapping = (
        [m.model_dump() for m in body.mapping]
        if body.mapping
        else (job.mapping_json or [])
    )
    catalog = CatalogRepository(session)
    existing = await catalog.skus_for_vendor(vendor_id)
    reverdicts = import_service.validate_rows(
        [r.raw_json for r in rows], mapping, existing_skus=existing
    )
    # validate_rows renumbers from 1; restore the original row numbers so the
    # errors the client renders line up with the preview it is showing.
    for verdict, row in zip(reverdicts, rows, strict=True):
        verdict["row_number"] = row.row_number

    good = [v for v in reverdicts if not v["errors"]]
    bad = [v for v in reverdicts if v["errors"]]

    if bad and not body.commit_valid_only:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"{len(bad)} row(s) have errors and partial import is off. "
                "Fix them or enable partial import."
            ),
        )

    if not body.update_existing_skus:
        skipped = [v for v in good if v["is_duplicate_sku"]]
        good = [v for v in good if not v["is_duplicate_sku"]]
        for verdict in skipped:
            verdict["errors"] = [
                {
                    "field": "sku",
                    "message": "Already in your catalog; updating was turned off.",
                }
            ]
        bad.extend(skipped)

    vendors = VendorRepository(session)
    vendor = await vendors.get_or_raise(vendor_id)
    currency = getattr(vendor, "currency", None) or settings.default_currency

    items = import_service.to_source_items(
        (v["parsed"] or {} for v in good), currency=currency
    )
    outcome = await CsvSource(items).apply(
        session, vendor_id=vendor_id, items=items
    )

    by_number = {r.row_number: r for r in rows}
    for verdict in good:
        row = by_number.get(verdict["row_number"])
        if row is not None:
            row.committed = True
            row.errors_json = []
    for verdict in bad:
        row = by_number.get(verdict["row_number"])
        if row is not None:
            row.errors_json = verdict["errors"]

    await jobs.mark_committed(
        job,
        committed=outcome.items_created + outcome.items_updated,
        failed=len(bad) + outcome.items_skipped,
        created=outcome.items_created,
        updated=outcome.items_updated,
        rows_missing_terms=sum(1 for v in good if v["missing_terms"]),
        mapping=mapping,
    )

    return {
        "job": _job_json(job),
        "failed_rows": bad,
        "items_needing_terms": sorted(
            {
                v["row_number"]
                for v in good
                if v["missing_terms"]
            }
        ),
    }


# --------------------------------------------------------------------------
# History
# --------------------------------------------------------------------------
@router.get("", summary="My recent imports")
async def list_jobs(session: SessionDep, vendor_id: VendorIdDep) -> dict[str, Any]:
    jobs = await ImportJobRepository(session).for_vendor(vendor_id)
    return {"items": [_job_json(j) for j in jobs], "total": len(jobs)}


@router.get("/{job_id}", summary="One import with its rows")
async def get_job(
    job_id: UUID, session: SessionDep, vendor_id: VendorIdDep
) -> dict[str, Any]:
    repo = ImportJobRepository(session)
    job = await repo.owned_by(job_id, vendor_id)
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Import job not found."
        )
    rows = await repo.rows_for(job_id)
    return {
        "job": _job_json(job),
        "mapping": job.mapping_json or [],
        "rows": [_row_json(r) for r in rows],
    }
