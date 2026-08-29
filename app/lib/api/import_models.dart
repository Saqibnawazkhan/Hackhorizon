/// Spreadsheet-import and catalog-connection models.
///
/// The import is two round trips: `preview` parses and validates without
/// writing anything, `commit` writes the subset the vendor approved. These
/// types are the shape of what comes back in between, which is what the
/// mapping and per-row-error UI renders.
library;

/// One column the catalog can accept, with the example that seeds the
/// downloadable template.
class ImportTargetField {
  const ImportTargetField({
    required this.name,
    required this.isRequired,
    required this.example,
    this.note,
  });

  final String name;
  final bool isRequired;
  final String example;
  final String? note;

  /// `delivery_days` -> `Delivery days`.
  String get label {
    final words = name.split('_');
    final head = words.first;
    final capitalised = head.isEmpty
        ? head
        : head[0].toUpperCase() + head.substring(1);
    return words.length > 1
        ? '$capitalised ${words.skip(1).join(' ')}'
        : capitalised;
  }

  factory ImportTargetField.fromJson(Map<String, dynamic> j) =>
      ImportTargetField(
        name: j['name'] as String,
        isRequired: j['required'] as bool? ?? false,
        example: '${j['example'] ?? ''}',
        note: j['note'] as String?,
      );
}

/// A spreadsheet column bound to a catalog field.
class ColumnMapping {
  const ColumnMapping({required this.sourceColumn, required this.targetField});

  final String sourceColumn;
  final String targetField;

  ColumnMapping withTarget(String? field) =>
      ColumnMapping(sourceColumn: sourceColumn, targetField: field ?? '');

  Map<String, dynamic> toJson() => {
        'source_column': sourceColumn,
        'target_field': targetField,
      };

  factory ColumnMapping.fromJson(Map<String, dynamic> j) => ColumnMapping(
        sourceColumn: j['source_column'] as String,
        targetField: j['target_field'] as String,
      );
}

class RowError {
  const RowError({required this.field, required this.message});

  final String field;
  final String message;

  factory RowError.fromJson(Map<String, dynamic> j) => RowError(
        field: '${j['field'] ?? ''}',
        message: '${j['message'] ?? ''}',
      );
}

/// One parsed row and the verdict on it.
class ImportRow {
  const ImportRow({
    required this.rowNumber,
    required this.raw,
    required this.parsed,
    required this.errors,
    required this.isDuplicateSku,
    required this.missingTerms,
    this.committed = false,
  });

  final int rowNumber;
  final Map<String, dynamic> raw;
  final Map<String, dynamic>? parsed;
  final List<RowError> errors;

  /// The SKU already exists, so committing updates it rather than creating.
  final bool isDuplicateSku;

  /// delivery_days / warranty_months absent. Not an error -- the vendor
  /// default applies, and the item is flagged if there is no default either.
  final List<String> missingTerms;
  final bool committed;

  bool get isValid => errors.isEmpty;

  String get displayTitle {
    final parsedTitle = '${parsed?['title'] ?? ''}'.trim();
    if (parsedTitle.isNotEmpty) return parsedTitle;
    for (final value in raw.values) {
      final text = '$value'.trim();
      if (text.isNotEmpty) return text;
    }
    return 'Row $rowNumber';
  }

  String get displaySku => '${parsed?['sku'] ?? ''}'.trim();

  factory ImportRow.fromJson(Map<String, dynamic> j) => ImportRow(
        rowNumber: (j['row_number'] as num?)?.toInt() ?? 0,
        raw: ((j['raw'] as Map?) ?? const {}).cast<String, dynamic>(),
        parsed: (j['parsed'] as Map?)?.cast<String, dynamic>(),
        errors: ((j['errors'] as List?) ?? const [])
            .map((e) => RowError.fromJson((e as Map).cast<String, dynamic>()))
            .toList(),
        isDuplicateSku: j['is_duplicate_sku'] as bool? ?? false,
        missingTerms: ((j['missing_terms'] as List?) ?? const [])
            .map((e) => '$e')
            .toList(),
        committed: j['committed'] as bool? ?? false,
      );
}

/// What `POST /imports/preview` returns. Nothing has been written yet.
class ImportPreview {
  const ImportPreview({
    required this.jobId,
    required this.filename,
    required this.detectedColumns,
    required this.suggestedMapping,
    required this.unmappedColumns,
    required this.targetFields,
    required this.rows,
    required this.totalRows,
    required this.validRows,
    required this.invalidRows,
    required this.duplicateRows,
    required this.rowsMissingTerms,
    required this.truncated,
  });

  final String jobId;
  final String filename;
  final List<String> detectedColumns;
  final List<ColumnMapping> suggestedMapping;
  final List<String> unmappedColumns;
  final List<ImportTargetField> targetFields;
  final List<ImportRow> rows;
  final int totalRows;
  final int validRows;
  final int invalidRows;
  final int duplicateRows;
  final int rowsMissingTerms;

  /// The file exceeded the row cap; only the first page was previewed.
  final bool truncated;

  factory ImportPreview.fromJson(Map<String, dynamic> j) => ImportPreview(
        jobId: '${j['import_job_id']}',
        filename: '${j['filename'] ?? 'upload'}',
        detectedColumns: ((j['detected_columns'] as List?) ?? const [])
            .map((e) => '$e')
            .toList(),
        suggestedMapping: ((j['suggested_mapping'] as List?) ?? const [])
            .map((e) =>
                ColumnMapping.fromJson((e as Map).cast<String, dynamic>()))
            .toList(),
        unmappedColumns: ((j['unmapped_columns'] as List?) ?? const [])
            .map((e) => '$e')
            .toList(),
        targetFields: ((j['target_fields'] as List?) ?? const [])
            .map((e) =>
                ImportTargetField.fromJson((e as Map).cast<String, dynamic>()))
            .toList(),
        rows: ((j['rows'] as List?) ?? const [])
            .map((e) => ImportRow.fromJson((e as Map).cast<String, dynamic>()))
            .toList(),
        totalRows: (j['total_rows'] as num?)?.toInt() ?? 0,
        validRows: (j['valid_rows'] as num?)?.toInt() ?? 0,
        invalidRows: (j['invalid_rows'] as num?)?.toInt() ?? 0,
        duplicateRows: (j['duplicate_rows'] as num?)?.toInt() ?? 0,
        rowsMissingTerms: (j['rows_missing_terms'] as num?)?.toInt() ?? 0,
        truncated: j['truncated'] as bool? ?? false,
      );
}

/// A finished (or failed) import.
class ImportJob {
  const ImportJob({
    required this.id,
    required this.filename,
    required this.status,
    required this.totalRows,
    required this.committedRows,
    required this.failedRows,
    required this.createdRows,
    required this.updatedRows,
    required this.rowsMissingTerms,
    required this.createdAt,
    this.error,
    this.committedAt,
  });

  final String id;
  final String filename;
  final String status;
  final int totalRows;
  final int committedRows;
  final int failedRows;
  final int createdRows;
  final int updatedRows;
  final int rowsMissingTerms;
  final DateTime createdAt;
  final String? error;
  final DateTime? committedAt;

  bool get isPartial => status == 'partially_committed';
  bool get isDone => status == 'committed' || isPartial;

  String get summaryLine => '$committedRows of $totalRows rows imported'
      '${failedRows > 0 ? ' · $failedRows skipped' : ''}';

  String get detailLine {
    final parts = <String>[];
    if (createdRows > 0) parts.add('$createdRows new');
    if (updatedRows > 0) parts.add('$updatedRows updated');
    if (rowsMissingTerms > 0) parts.add('$rowsMissingTerms need terms');
    return parts.join(' · ');
  }

  factory ImportJob.fromJson(Map<String, dynamic> j) => ImportJob(
        id: '${j['id']}',
        filename: '${j['filename'] ?? ''}',
        status: '${j['status'] ?? ''}',
        totalRows: (j['total_rows'] as num?)?.toInt() ?? 0,
        committedRows: (j['committed_rows'] as num?)?.toInt() ?? 0,
        failedRows: (j['failed_rows'] as num?)?.toInt() ?? 0,
        createdRows: (j['created_rows'] as num?)?.toInt() ?? 0,
        updatedRows: (j['updated_rows'] as num?)?.toInt() ?? 0,
        rowsMissingTerms: (j['rows_missing_terms'] as num?)?.toInt() ?? 0,
        createdAt: DateTime.tryParse('${j['created_at']}')?.toLocal() ??
            DateTime.now(),
        error: j['error'] as String?,
        committedAt: DateTime.tryParse('${j['committed_at']}')?.toLocal(),
      );
}

class ImportCommitResult {
  const ImportCommitResult({required this.job, required this.failedRows});

  final ImportJob job;
  final List<ImportRow> failedRows;

  factory ImportCommitResult.fromJson(Map<String, dynamic> j) =>
      ImportCommitResult(
        job: ImportJob.fromJson((j['job'] as Map).cast<String, dynamic>()),
        failedRows: ((j['failed_rows'] as List?) ?? const [])
            .map((e) => ImportRow.fromJson((e as Map).cast<String, dynamic>()))
            .toList(),
      );
}

/// A catalog API connection (Shopify / WooCommerce / generic REST).
///
/// Sync runs against a seeded fixture -- the plumbing is real, the provider
/// call is not. Credentials are write-only: `credentialsSet` is all the API
/// will ever tell the client about them.
class CatalogConnection {
  const CatalogConnection({
    required this.id,
    required this.provider,
    required this.label,
    required this.status,
    required this.autoSyncEnabled,
    required this.credentialsSet,
    required this.statusLine,
    this.storeUrl,
    this.lastSyncAt,
    this.lastSyncItemCount,
    this.lastError,
  });

  final String id;
  final String provider;
  final String label;
  final String status;
  final bool autoSyncEnabled;
  final bool credentialsSet;
  final String statusLine;
  final String? storeUrl;
  final DateTime? lastSyncAt;
  final int? lastSyncItemCount;
  final String? lastError;

  bool get isConnected => status == 'connected';
  bool get hasError => status == 'error' || (lastError ?? '').isNotEmpty;

  factory CatalogConnection.fromJson(Map<String, dynamic> j) =>
      CatalogConnection(
        id: '${j['id']}',
        provider: '${j['provider'] ?? ''}',
        label: '${j['label'] ?? ''}',
        status: '${j['status'] ?? 'disconnected'}',
        autoSyncEnabled: j['auto_sync_enabled'] as bool? ?? false,
        credentialsSet: j['credentials_set'] as bool? ?? false,
        statusLine: '${j['status_line'] ?? ''}',
        storeUrl: j['store_url'] as String?,
        lastSyncAt: DateTime.tryParse('${j['last_sync_at']}')?.toLocal(),
        lastSyncItemCount: (j['last_sync_item_count'] as num?)?.toInt(),
        lastError: j['last_error'] as String?,
      );
}

class CatalogSyncResult {
  const CatalogSyncResult({
    required this.itemsFetched,
    required this.itemsCreated,
    required this.itemsUpdated,
    required this.itemsSkipped,
    required this.isSimulated,
    required this.message,
  });

  final int itemsFetched;
  final int itemsCreated;
  final int itemsUpdated;
  final int itemsSkipped;
  final bool isSimulated;
  final String message;

  factory CatalogSyncResult.fromJson(Map<String, dynamic> j) =>
      CatalogSyncResult(
        itemsFetched: (j['items_fetched'] as num?)?.toInt() ?? 0,
        itemsCreated: (j['items_created'] as num?)?.toInt() ?? 0,
        itemsUpdated: (j['items_updated'] as num?)?.toInt() ?? 0,
        itemsSkipped: (j['items_skipped'] as num?)?.toInt() ?? 0,
        isSimulated: j['is_simulated'] as bool? ?? true,
        message: '${j['message'] ?? ''}',
      );
}

/// The providers the connect form offers.
enum CatalogProviderOption {
  shopify('shopify', 'Shopify', 'yourstore.myshopify.com'),
  woocommerce('woocommerce', 'WooCommerce', 'https://yourstore.com'),
  genericRest(
    'generic_rest',
    'Generic REST',
    'https://api.yourerp.com/products',
  );

  const CatalogProviderOption(this.wire, this.label, this.urlHint);

  final String wire;
  final String label;
  final String urlHint;

  static CatalogProviderOption fromWire(String wire) =>
      CatalogProviderOption.values.firstWhere(
        (p) => p.wire == wire,
        orElse: () => CatalogProviderOption.genericRest,
      );
}
