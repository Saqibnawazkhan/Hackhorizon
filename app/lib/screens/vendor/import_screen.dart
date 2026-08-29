/// Spreadsheet import for the vendor portal.
///
/// Three states in one screen, because they are one task:
///
///   pick     -- what the file needs to contain, and a template to start from
///   review   -- the inferred column mapping (editable) and every row's verdict
///   done     -- what landed, what did not, and why
///
/// The review step is the point of the whole flow. Uploading writes nothing;
/// the vendor sees which of their columns we read as `price`, which rows will
/// fail and for what reason, and which SKUs will be updated rather than
/// created -- and only then commits. Getting that wrong on a price list is
/// expensive in a way that is not obvious until a purchase order is generated
/// from it weeks later.
library;

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/import_models.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../theme/surfaces.dart';
import '../../theme/tokens.dart';
import '../../widgets/common.dart';
import '../../widgets/shell.dart';
import '../../widgets/workflow_widgets.dart';
import '../../state/cached.dart';

class ImportScreen extends ConsumerStatefulWidget {
  const ImportScreen({super.key});

  @override
  ConsumerState<ImportScreen> createState() => _ImportScreenState();
}

enum _Stage { pick, review, done }

class _ImportScreenState extends ConsumerState<ImportScreen> {
  _Stage _stage = _Stage.pick;
  bool _busy = false;
  String? _error;

  ImportPreview? _preview;

  /// Edits to the suggested mapping, keyed by source column. Absent means
  /// "as suggested"; an empty string means the vendor unmapped it.
  final Map<String, String> _mappingEdits = {};

  /// Rows the vendor excluded by hand. Invalid rows are excluded by the
  /// backend regardless; this is for valid rows they simply do not want.
  final Set<int> _excluded = {};

  bool _updateExisting = true;
  ImportCommitResult? _result;

  // ---------------------------------------------------------------- pick
  Future<void> _pickFile() async {
    FilePickerResult? picked;
    try {
      picked = await FilePicker.platform.pickFiles(
        type: FileType.custom,
        allowedExtensions: const ['csv', 'xlsx', 'xlsm', 'txt'],
        withData: true, // we upload bytes, never a path
      );
    } on PlatformException catch (e) {
      setState(() => _error = 'Could not open the file picker: ${e.message}');
      return;
    }
    if (picked == null || picked.files.isEmpty) return;

    final file = picked.files.single;
    final bytes = file.bytes;
    if (bytes == null) {
      setState(() => _error = 'That file could not be read.');
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final preview = await ref
          .read(apiClientProvider)
          .previewImport(filename: file.name, bytes: bytes);
      if (!mounted) return;
      setState(() {
        _preview = preview;
        _mappingEdits.clear();
        _excluded.clear();
        _stage = _Stage.review;
        _busy = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.message;
      });
    }
  }

  // -------------------------------------------------------------- mapping
  List<ColumnMapping> get _effectiveMapping {
    final preview = _preview!;
    final byColumn = {
      for (final m in preview.suggestedMapping) m.sourceColumn: m.targetField,
    };
    for (final entry in _mappingEdits.entries) {
      byColumn[entry.key] = entry.value;
    }
    return [
      for (final entry in byColumn.entries)
        if (entry.value.isNotEmpty)
          ColumnMapping(sourceColumn: entry.key, targetField: entry.value),
    ];
  }

  bool get _mappingEdited => _mappingEdits.isNotEmpty;

  Set<String> get _mappedTargets =>
      _effectiveMapping.map((m) => m.targetField).toSet();

  List<String> get _missingRequired {
    final mapped = _mappedTargets;
    return [
      for (final f in _preview!.targetFields)
        if (f.isRequired && !mapped.contains(f.name)) f.name,
    ];
  }

  void _remap(String column, String? target) {
    setState(() {
      // A target belongs to one column. Re-pointing it here has to clear
      // whichever column held it, or the commit sends two mappings for price
      // and the second silently wins.
      if (target != null && target.isNotEmpty) {
        for (final m in _effectiveMapping) {
          if (m.targetField == target && m.sourceColumn != column) {
            _mappingEdits[m.sourceColumn] = '';
          }
        }
      }
      _mappingEdits[column] = target ?? '';
    });
  }

  // --------------------------------------------------------------- commit
  int get _selectedCount {
    final preview = _preview;
    if (preview == null) return 0;
    return preview.rows
        .where((r) => r.isValid && !_excluded.contains(r.rowNumber))
        .length;
  }

  Future<void> _commit() async {
    final preview = _preview!;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = await ref.read(apiClientProvider).commitImport(
            preview.jobId,
            // Only send a mapping when it was actually edited; otherwise the
            // stored one is reused and the two cannot drift.
            mapping: _mappingEdited ? _effectiveMapping : null,
            updateExistingSkus: _updateExisting,
            rowNumbers: _excluded.isEmpty
                ? null
                : [
                    for (final r in preview.rows)
                      if (!_excluded.contains(r.rowNumber)) r.rowNumber,
                  ],
          );
      ref.invalidate(myCatalogProvider);
      ref.invalidate(importHistoryProvider);
      if (!mounted) return;
      setState(() {
        _result = result;
        _stage = _Stage.done;
        _busy = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.message;
      });
    }
  }

  // ----------------------------------------------------------------- build
  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      header: AppHeader(
        title: 'Import price list',
        subtitle: switch (_stage) {
          _Stage.pick => 'CSV or Excel',
          _Stage.review => _preview?.filename ?? '',
          _Stage.done => 'Import complete',
        },
        onBack: _stage == _Stage.review
            ? () => setState(() {
                  _stage = _Stage.pick;
                  _preview = null;
                })
            : null,
      ),
      footer: switch (_stage) {
        _Stage.pick => PrimaryButton(
            label: 'Choose a file',
            icon: Icons.upload_file_outlined,
            busy: _busy,
            onPressed: _pickFile,
          ),
        _Stage.review => PrimaryButton(
            label: _selectedCount == 0
                ? 'Nothing to import'
                : 'Import $_selectedCount ${_selectedCount == 1 ? 'row' : 'rows'}',
            busy: _busy,
            onPressed:
                _selectedCount == 0 || _missingRequired.isNotEmpty
                    ? null
                    : _commit,
          ),
        _Stage.done => PrimaryButton(
            label: 'Back to portal',
            onPressed: () => Navigator.of(context).pop(),
          ),
      },
      child: switch (_stage) {
        _Stage.pick => _PickStage(error: _error, busy: _busy),
        _Stage.review => _buildReview(),
        _Stage.done => _DoneStage(result: _result!),
      },
    );
  }

  Widget _buildReview() {
    final preview = _preview!;
    final missing = _missingRequired;

    return ListView(
      padding: const EdgeInsets.only(bottom: 16),
      children: [
        _SummaryStrip(preview: preview, selected: _selectedCount),
        if (preview.truncated) ...[
          const SizedBox(height: 12),
          InfoBanner(
            title: 'Only the first ${preview.totalRows} rows were read',
            message: 'Split the file and import the rest in a second pass.',
            tone: PillTone.warning,
            icon: Icons.content_cut_outlined,
          ),
        ],
        if (missing.isNotEmpty) ...[
          const SizedBox(height: 12),
          InfoBanner(
            title: 'Map ${missing.join(', ')} to continue',
            message: 'The catalog cannot store a row without these.',
            tone: PillTone.danger,
            icon: Icons.link_off_outlined,
          ),
        ],
        if (_error != null) ...[
          const SizedBox(height: 12),
          InfoBanner(
            message: _error!,
            tone: PillTone.danger,
            icon: Icons.error_outline,
          ),
        ],
        const SizedBox(height: 16),
        SectionHeader(
          title: 'Column mapping',
          actionLabel: _mappingEdited ? 'Reset' : null,
          onAction: _mappingEdited
              ? () => setState(_mappingEdits.clear)
              : null,
        ),
        const SizedBox(height: 8),
        _MappingCard(
          preview: preview,
          mapping: _effectiveMapping,
          onChanged: _remap,
        ),
        const SizedBox(height: 16),
        GlassCard(
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Update items I already list',
                      style: AppText.captionStrong(AppColors.ink),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      preview.duplicateRows == 0
                          ? 'No SKU in this file is already in your catalog.'
                          : '${preview.duplicateRows} row(s) match an existing '
                              'SKU. Off, they are skipped instead.',
                      style: AppText.meta(),
                    ),
                  ],
                ),
              ),
              Switch(
                value: _updateExisting,
                activeThumbColor: AppColors.turquoise,
                onChanged: preview.duplicateRows == 0
                    ? null
                    : (v) => setState(() => _updateExisting = v),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        SectionHeader(title: 'Rows (${preview.totalRows})'),
        const SizedBox(height: 8),
        for (final row in preview.rows)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: _RowCard(
              row: row,
              excluded: _excluded.contains(row.rowNumber),
              onToggle: row.isValid
                  ? () => setState(() {
                        if (!_excluded.remove(row.rowNumber)) {
                          _excluded.add(row.rowNumber);
                        }
                      })
                  : null,
            ),
          ),
      ],
    );
  }
}

// ===========================================================================
// Stage 1 -- what the file needs
// ===========================================================================
class _PickStage extends ConsumerWidget {
  const _PickStage({this.error, this.busy = false});

  final String? error;
  final bool busy;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final template = ref.watch(importTemplateProvider);

    return ListView(
      padding: const EdgeInsets.only(bottom: 16),
      children: [
        if (error != null) ...[
          InfoBanner(
            title: 'That file could not be imported',
            message: error!,
            tone: PillTone.danger,
            icon: Icons.error_outline,
          ),
          const SizedBox(height: 12),
        ],
        ClayCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('What we read', style: AppText.sectionTitle()),
              const SizedBox(height: 6),
              Text(
                'Column names do not have to match. We map common spellings '
                'automatically and you can correct anything we get wrong '
                'before a single row is written.',
                style: AppText.explain(),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        template.cachedWhen(
          loading: () => const SkeletonBox(height: 220, radius: AppRadii.card),
          error: (e, _) => ErrorState(
            message: '$e',
            onRetry: () => ref.invalidate(importTemplateProvider),
          ),
          data: (t) => _TemplateCard(template: t),
        ),
        const SizedBox(height: 12),
        MutedSurface(
          borderColor: AppColors.platinum,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(
                Icons.info_outline,
                size: 15,
                color: AppColors.muted,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Delivery and warranty may be left out. Your vendor defaults '
                  'fill them in; with no default either, the item is flagged '
                  'and scores lower on data confidence.',
                  style: AppText.meta(),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _TemplateCard extends StatelessWidget {
  const _TemplateCard({required this.template});

  final Map<String, dynamic> template;

  @override
  Widget build(BuildContext context) {
    final columns = ((template['columns'] as List?) ?? const [])
        .map((e) => ImportTargetField.fromJson((e as Map).cast<String, dynamic>()))
        .toList();
    final csv = '${template['csv'] ?? ''}';

    return GlassCard(
      padding: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
            child: Row(
              children: [
                Expanded(
                  child: Text('Columns', style: AppText.sectionTitle()),
                ),
                if (csv.isNotEmpty)
                  GestureDetector(
                    onTap: () async {
                      await Clipboard.setData(ClipboardData(text: csv));
                      if (context.mounted) {
                        showToast(context, 'Template copied to the clipboard');
                      }
                    },
                    child: Row(
                      children: [
                        const Icon(
                          Icons.copy_all_outlined,
                          size: 14,
                          color: AppColors.turquoise,
                        ),
                        const SizedBox(width: 4),
                        Text(
                          'Copy template',
                          style: AppText.captionStrong(AppColors.turquoise),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
          const HairLine(),
          for (final (i, column) in columns.indexed) ...[
            if (i > 0) const HairLine(),
            Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: 16,
                vertical: 11,
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Text(
                              column.name,
                              style: AppText.listTitleSm(),
                            ),
                            const SizedBox(width: 6),
                            if (column.isRequired)
                              const StatusPill(
                                label: 'Required',
                                tone: PillTone.danger,
                                showDot: false,
                              ),
                          ],
                        ),
                        if (column.note != null) ...[
                          const SizedBox(height: 3),
                          Text(column.note!, style: AppText.meta()),
                        ],
                      ],
                    ),
                  ),
                  const SizedBox(width: 10),
                  Text(
                    column.example,
                    style: AppText.meta(AppColors.subtle),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

// ===========================================================================
// Stage 2 -- summary, mapping, rows
// ===========================================================================
class _SummaryStrip extends StatelessWidget {
  const _SummaryStrip({required this.preview, required this.selected});

  final ImportPreview preview;
  final int selected;

  @override
  Widget build(BuildContext context) => Row(
        children: [
          Expanded(
            child: StatCard(
              value: '$selected',
              label: 'Will import',
              tone: 'positive',
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: StatCard(
              value: '${preview.invalidRows}',
              label: 'Have errors',
              tone: preview.invalidRows > 0 ? 'danger' : 'neutral',
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: StatCard(
              value: '${preview.duplicateRows}',
              label: 'Update existing',
              tone: 'neutral',
            ),
          ),
        ],
      );
}

class _MappingCard extends StatelessWidget {
  const _MappingCard({
    required this.preview,
    required this.mapping,
    required this.onChanged,
  });

  final ImportPreview preview;
  final List<ColumnMapping> mapping;
  final void Function(String column, String? target) onChanged;

  @override
  Widget build(BuildContext context) {
    final byColumn = {for (final m in mapping) m.sourceColumn: m.targetField};

    return GlassCard(
      padding: EdgeInsets.zero,
      child: Column(
        children: [
          for (final (i, column) in preview.detectedColumns.indexed) ...[
            if (i > 0) const HairLine(),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 12, 10),
              child: Row(
                children: [
                  Expanded(
                    flex: 4,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          column,
                          style: AppText.listTitleSm(),
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 2),
                        Text(
                          _sample(column),
                          style: AppText.meta(AppColors.subtle),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                    ),
                  ),
                  const Icon(
                    Icons.arrow_forward,
                    size: 14,
                    color: AppColors.disabled,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    flex: 5,
                    child: _TargetDropdown(
                      value: byColumn[column],
                      fields: preview.targetFields,
                      onChanged: (v) => onChanged(column, v),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// The first non-empty value in that column, so the vendor can see what
  /// they are actually mapping rather than trusting the header alone.
  String _sample(String column) {
    for (final row in preview.rows) {
      final value = '${row.raw[column] ?? ''}'.trim();
      if (value.isNotEmpty) {
        return value.length > 28 ? '${value.substring(0, 28)}…' : value;
      }
    }
    return 'empty';
  }
}

class _TargetDropdown extends StatelessWidget {
  const _TargetDropdown({
    required this.value,
    required this.fields,
    required this.onChanged,
  });

  final String? value;
  final List<ImportTargetField> fields;
  final ValueChanged<String?> onChanged;

  @override
  Widget build(BuildContext context) {
    final ignored = value == null || value!.isEmpty;
    return Container(
      height: 40,
      padding: const EdgeInsets.symmetric(horizontal: 10),
      decoration: BoxDecoration(
        color: ignored ? AppColors.neutralBg : AppColors.inputFill,
        borderRadius: BorderRadius.circular(AppRadii.field),
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<String>(
          value: ignored ? '' : value,
          isExpanded: true,
          isDense: true,
          icon: const Icon(
            Icons.expand_more,
            size: 16,
            color: AppColors.muted,
          ),
          style: AppText.captionStrong(
            ignored ? AppColors.subtle : AppColors.ink,
          ),
          items: [
            const DropdownMenuItem(value: '', child: Text('Ignore')),
            for (final f in fields)
              DropdownMenuItem(
                value: f.name,
                child: Text(f.isRequired ? '${f.label} *' : f.label),
              ),
          ],
          onChanged: onChanged,
        ),
      ),
    );
  }
}

class _RowCard extends StatelessWidget {
  const _RowCard({
    required this.row,
    required this.excluded,
    required this.onToggle,
  });

  final ImportRow row;
  final bool excluded;
  final VoidCallback? onToggle;

  @override
  Widget build(BuildContext context) {
    final skipped = excluded || !row.isValid;

    Widget card = OutlinedSurface(
      borderColor: !row.isValid
          ? AppColors.dangerBorder
          : excluded
              ? AppColors.platinum
              : row.isDuplicateSku
                  ? AppColors.glacier
                  : AppColors.successSolid,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 26,
                child: Text(
                  '${row.rowNumber}',
                  style: AppText.meta(AppColors.subtle),
                ),
              ),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      row.displayTitle,
                      style: AppText.listTitleSm(
                        skipped ? AppColors.subtle : AppColors.ink,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    if (row.displaySku.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(row.displaySku, style: AppText.meta()),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 8),
              if (!row.isValid)
                const StatusPill(
                  label: 'Error',
                  tone: PillTone.danger,
                  showDot: false,
                )
              else if (excluded)
                const StatusPill(
                  label: 'Skipped',
                  tone: PillTone.neutral,
                  showDot: false,
                )
              else if (row.isDuplicateSku)
                const StatusPill(
                  label: 'Updates',
                  tone: PillTone.info,
                  showDot: false,
                )
              else
                const StatusPill(
                  label: 'New',
                  tone: PillTone.success,
                  showDot: false,
                ),
              if (onToggle != null)
                IconButton(
                  visualDensity: VisualDensity.compact,
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(
                    minWidth: 32,
                    minHeight: 32,
                  ),
                  icon: Icon(
                    excluded
                        ? Icons.add_circle_outline
                        : Icons.remove_circle_outline,
                    size: 18,
                    color: excluded ? AppColors.turquoise : AppColors.disabled,
                  ),
                  onPressed: onToggle,
                ),
            ],
          ),
          for (final error in row.errors) ...[
            const SizedBox(height: 6),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SizedBox(width: 26),
                const Icon(
                  Icons.error_outline,
                  size: 13,
                  color: AppColors.dangerFg,
                ),
                const SizedBox(width: 5),
                Expanded(
                  child: Text(
                    '${error.field}: ${error.message}',
                    style: AppText.meta(AppColors.dangerFg),
                  ),
                ),
              ],
            ),
          ],
          if (row.isValid && row.missingTerms.isNotEmpty) ...[
            const SizedBox(height: 6),
            Row(
              children: [
                const SizedBox(width: 26),
                const Icon(
                  Icons.schedule_outlined,
                  size: 13,
                  color: AppColors.warningFg,
                ),
                const SizedBox(width: 5),
                Expanded(
                  child: Text(
                    'No ${row.missingTerms.map(_pretty).join(' or ')} — your '
                    'vendor default will apply.',
                    style: AppText.meta(AppColors.warningFg),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );

    return skipped ? Opacity(opacity: 0.72, child: card) : card;
  }

  static String _pretty(String field) =>
      field.replaceAll('_', ' ').replaceAll(' days', ' time');
}

// ===========================================================================
// Stage 3 -- what landed
// ===========================================================================
class _DoneStage extends StatelessWidget {
  const _DoneStage({required this.result});

  final ImportCommitResult result;

  @override
  Widget build(BuildContext context) {
    final job = result.job;
    return ListView(
      padding: const EdgeInsets.only(bottom: 16),
      children: [
        ClayCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    job.isPartial
                        ? Icons.check_circle_outline
                        : Icons.check_circle,
                    size: 20,
                    color: job.isPartial
                        ? AppColors.warningFg
                        : AppColors.successFg,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(job.summaryLine, style: AppText.sectionTitle()),
                  ),
                ],
              ),
              if (job.detailLine.isNotEmpty) ...[
                const SizedBox(height: 6),
                Text(job.detailLine, style: AppText.meta()),
              ],
              const SizedBox(height: 8),
              Text(
                'Imported items are drafts until you publish, exactly like '
                'items you add by hand.',
                style: AppText.explain(),
              ),
            ],
          ),
        ),
        if (job.rowsMissingTerms > 0) ...[
          const SizedBox(height: 12),
          InfoBanner(
            title: '${job.rowsMissingTerms} item(s) arrived without terms',
            message: 'Set delivery and warranty on them so buyers see full '
                'data confidence.',
            tone: PillTone.warning,
            icon: Icons.schedule_outlined,
          ),
        ],
        if (result.failedRows.isNotEmpty) ...[
          const SizedBox(height: 16),
          SectionHeader(title: 'Not imported (${result.failedRows.length})'),
          const SizedBox(height: 8),
          for (final row in result.failedRows)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: _RowCard(row: row, excluded: false, onToggle: null),
            ),
          const SizedBox(height: 4),
          Text(
            'Fix these rows in your spreadsheet and import the file again — '
            'the rows that already landed will be updated, not duplicated.',
            style: AppText.explain(),
          ),
        ],
      ],
    );
  }
}
