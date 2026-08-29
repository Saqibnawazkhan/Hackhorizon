/// Opening a purchase-order PDF.
///
/// The Storage bucket is private, because a purchase order is a commercial
/// document. The backend hands out a short-lived signed URL instead, and it is
/// that signature — not our bearer token — which authorises the read. That is
/// what makes it openable by the phone's own PDF viewer: an external app has
/// no access to our session, but it does not need one.
///
/// Every failure is reported. A button that silently does nothing is how this
/// went unnoticed in the first place — the previous implementation was a
/// `showToast('Signed URL ready. Opening needs url_launcher.')` stub.
library;

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../theme/app_theme.dart';
import '../theme/tokens.dart';
import 'common.dart';
import 'shell.dart';

/// Opens [url] in whatever the device uses for PDFs. Returns false on failure.
Future<bool> openPdf(BuildContext context, String? url) async {
  if (url == null || url.isEmpty) {
    showToast(
      context,
      'No PDF is stored for this order yet.',
      danger: true,
    );
    return false;
  }

  final uri = Uri.tryParse(url);
  if (uri == null) {
    showToast(context, 'That document link is malformed.', danger: true);
    return false;
  }

  try {
    // externalApplication, not inAppWebView: a signed URL served as
    // application/pdf is handled properly by the system viewer, which can
    // also save and share it. An in-app webview would just download it
    // somewhere the user cannot reach.
    final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!ok && context.mounted) {
      showToast(context, 'No app on this device can open a PDF.', danger: true);
    }
    return ok;
  } catch (e) {
    if (context.mounted) {
      showToast(context, 'Could not open the PDF: $e', danger: true);
    }
    return false;
  }
}

/// The "View PDF" control from screens 7a and 12a.
///
/// Renders as disabled — with the reason — rather than vanishing when no PDF
/// exists, so the absence is legible instead of mysterious.
class PdfButton extends StatelessWidget {
  const PdfButton({
    super.key,
    required this.pdfUrl,
    this.label = 'View PDF',
    this.expanded = true,
  });

  final String? pdfUrl;
  final String label;
  final bool expanded;

  @override
  Widget build(BuildContext context) {
    final available = pdfUrl != null && pdfUrl!.isNotEmpty;
    final button = SecondaryButton(
      label: available ? label : 'PDF not available',
      icon: available
          ? Icons.picture_as_pdf_outlined
          : Icons.report_gmailerrorred_outlined,
      height: 44,
      onPressed: available ? () => openPdf(context, pdfUrl) : null,
    );
    return expanded ? SizedBox(width: double.infinity, child: button) : button;
  }
}

/// A tappable row — screen 8a's "View detailed PO (PDF)" with a chevron.
class PdfRow extends StatelessWidget {
  const PdfRow({super.key, required this.pdfUrl, this.subtitle});

  final String? pdfUrl;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    final available = pdfUrl != null && pdfUrl!.isNotEmpty;
    return GestureDetector(
      onTap: available ? () => openPdf(context, pdfUrl) : null,
      behavior: HitTestBehavior.opaque,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Row(
          children: [
            Icon(
              Icons.picture_as_pdf_outlined,
              size: 18,
              color: available ? AppColors.turquoise : AppColors.disabled,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    available
                        ? 'View detailed PO (PDF)'
                        : 'PDF not available',
                    style: AppText.listTitleSm(
                      available ? AppColors.ink : AppColors.subtle,
                    ),
                  ),
                  if (subtitle != null) ...[
                    const SizedBox(height: 2),
                    Text(subtitle!, style: AppText.meta()),
                  ],
                ],
              ),
            ),
            if (available)
              const Icon(
                Icons.chevron_right,
                size: 18,
                color: AppColors.subtle,
              ),
          ],
        ),
      ),
    );
  }
}
