/// Screens 2a and 3a -- new request chat intake, then the execution plan.
///
/// 2a is a chat: the user's request as a gradient bubble, the agent's reply as
/// a glass bubble, then an extracted-entities card. 3a is the numbered plan
/// the agent intends to execute, shown BEFORE anything runs -- confirming it
/// is what starts execution.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/models.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../theme/surfaces.dart';
import '../../theme/tokens.dart';
import '../../widgets/common.dart';
import '../../widgets/shell.dart';
import 'workflow_detail_screen.dart';

class NewRequestScreen extends ConsumerStatefulWidget {
  const NewRequestScreen({super.key});

  @override
  ConsumerState<NewRequestScreen> createState() => _NewRequestScreenState();
}

class _NewRequestScreenState extends ConsumerState<NewRequestScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();

  String? _sentText;
  WorkflowPlan? _plan;
  bool _planning = false;
  bool _starting = false;
  String? _error;

  /// The brief's primary demo, offered as a one-tap suggestion.
  static const _suggestions = [
    'Create a purchase request for 50 laptops under PKR 10 million, compare '
        'three suppliers, identify the best option, prepare the purchase '
        'order, and send it for approval.',
    '50 laptops, 20 Intel i7 CPU kits, 60 USB-C docking kits under PKR 12 '
        'million.',
    'I need to claim back PKR 85,000 for my Karachi client visit last week - '
        'two nights hotel, flights and meals. Receipts attached.',
  ];

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.length < 8) return;

    setState(() {
      _sentText = text;
      _planning = true;
      _error = null;
      _plan = null;
    });
    _input.clear();
    FocusScope.of(context).unfocus();

    try {
      final plan = await ref.read(apiClientProvider).createWorkflow(text);
      if (!mounted) return;
      setState(() {
        _plan = plan;
        _planning = false;
      });
      _scrollToEnd();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _planning = false;
        _error = e.message;
      });
    }
  }

  Future<void> _confirmAndRun() async {
    final plan = _plan;
    if (plan == null) return;
    setState(() => _starting = true);
    try {
      await ref.read(apiClientProvider).runWorkflow(plan.workflowId);
      if (!mounted) return;
      HapticFeedback.lightImpact();
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(
          builder: (_) => WorkflowDetailScreen(
            workflowId: plan.workflowId,
            live: true,
          ),
        ),
      );
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _starting = false);
      showToast(context, e.message, danger: true);
    }
  }

  void _scrollToEnd() => WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scroll.hasClients) {
          _scroll.animateTo(
            _scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 260),
            curve: Curves.easeOut,
          );
        }
      });

  @override
  Widget build(BuildContext context) => AppScaffold(
        header: AppHeader(
          title: 'New Request',
          trailing: StatusPill(
            label: _plan == null ? 'Draft' : 'Plan ready',
            tone: _plan == null ? PillTone.neutral : PillTone.info,
            showDot: false,
          ),
        ),
        padHorizontal: false,
        footer: _plan == null ? _composer() : _confirmBar(),
        child: ListView(
          controller: _scroll,
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
          children: [
            Center(
              child: Text(
                'Today · ${TimeOfDay.now().format(context)}',
                style: AppText.pill(AppColors.subtle),
              ),
            ),
            const SizedBox(height: 12),

            if (_sentText == null) ..._intro(),

            if (_sentText != null) ...[
              _userBubble(_sentText!),
              const SizedBox(height: 12),
              if (_planning) _agentBubble(_thinking()),
              if (_error != null)
                _agentBubble(
                  InfoBanner(
                    message: _error!,
                    tone: PillTone.danger,
                    icon: Icons.error_outline,
                  ),
                ),
              if (_plan != null) ...[
                _agentBubble(
                  Text(
                    'Got it. I extracted the details below — review anything, '
                    'then confirm to generate an execution plan.',
                    style: AppText.body(AppColors.bubbleText),
                  ),
                ),
                const SizedBox(height: 12),
                _entitiesCard(_plan!),
                const SizedBox(height: 12),
                _planCard(_plan!),
              ],
            ],
          ],
        ),
      );

  // -- intro -------------------------------------------------------------
  List<Widget> _intro() => [
        GlassCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    width: 28,
                    height: 28,
                    decoration: const BoxDecoration(
                      gradient: AppGradients.avatar,
                      shape: BoxShape.circle,
                    ),
                    child: const Icon(
                      Icons.auto_awesome,
                      size: 14,
                      color: AppColors.white,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text('AgentFlow', style: AppText.listTitle()),
                ],
              ),
              const SizedBox(height: 10),
              Text(
                'Describe what you need in plain English. I will work out the '
                'type of request, extract the details, and show you a plan '
                'before anything runs.',
                style: AppText.body(AppColors.bubbleText),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        Text('Try one of these', style: AppText.captionStrong(AppColors.muted)),
        const SizedBox(height: 8),
        for (final s in _suggestions) ...[
          GlassCard(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            onTap: () {
              _input.text = s;
              setState(() {});
            },
            child: Row(
              children: [
                Expanded(
                  child: Text(s, style: AppText.caption(AppColors.ink)),
                ),
                const SizedBox(width: 8),
                const Icon(
                  Icons.arrow_forward,
                  size: 15,
                  color: AppColors.turquoise,
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
        ],
      ];

  // -- bubbles -----------------------------------------------------------
  Widget _userBubble(String text) => Align(
        alignment: Alignment.centerRight,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 300),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: const BoxDecoration(
              gradient: AppGradients.cta,
              borderRadius: BorderRadius.only(
                topLeft: Radius.circular(18),
                topRight: Radius.circular(18),
                bottomLeft: Radius.circular(18),
                bottomRight: Radius.circular(4),
              ),
            ),
            child: Text(text, style: AppText.body(AppColors.white)),
          ),
        ),
      );

  Widget _agentBubble(Widget child) => Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Container(
            width: 28,
            height: 28,
            decoration: const BoxDecoration(
              gradient: AppGradients.avatar,
              shape: BoxShape.circle,
            ),
            child: const Icon(
              Icons.auto_awesome,
              size: 14,
              color: AppColors.white,
            ),
          ),
          const SizedBox(width: 8),
          Flexible(
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              decoration: BoxDecoration(
                color: AppColors.white.withValues(alpha: 0.65),
                border: Border.all(color: const Color(0xCCFFFFFF)),
                borderRadius: const BorderRadius.only(
                  topLeft: Radius.circular(18),
                  topRight: Radius.circular(18),
                  bottomRight: Radius.circular(18),
                  bottomLeft: Radius.circular(4),
                ),
              ),
              child: child,
            ),
          ),
        ],
      );

  Widget _thinking() => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(
            width: 14,
            height: 14,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              valueColor: AlwaysStoppedAnimation(AppColors.turquoise),
            ),
          ),
          const SizedBox(width: 10),
          Text('Reading your request…', style: AppText.body(AppColors.bubbleText)),
        ],
      );

  // -- extracted entities (2a) -------------------------------------------
  Widget _entitiesCard(WorkflowPlan plan) {
    final e = plan.entities;
    return Padding(
      padding: const EdgeInsets.only(left: 36),
      child: GlassCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text('Extracted details', style: AppText.sectionTitle()),
                ),
                // The planner inferred this from the text alone -- no dropdown.
                StatusPill(
                  label: e.workflowType == 'procurement'
                      ? 'Procurement'
                      : 'Reimbursement',
                  tone: PillTone.info,
                  showDot: false,
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              'Workflow type inferred from your wording.',
              style: AppText.meta(),
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final item in e.items)
                  EntityChip(label: item.chipLabel),
              ],
            ),
            const SizedBox(height: 12),
            const HairLine(),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: MetaRow(
                    label: 'Budget',
                    value: formatMoney(e.budget, e.currency),
                  ),
                ),
                Expanded(
                  child: MetaRow(
                    label: 'Items',
                    value: '${e.items.length}',
                  ),
                ),
              ],
            ),
            if (plan.selfCorrected) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  const Icon(
                    Icons.autorenew,
                    size: 12,
                    color: AppColors.warningFg,
                  ),
                  const SizedBox(width: 5),
                  Expanded(
                    child: Text(
                      'The planner corrected its own output '
                      '(${plan.plannerAttempts} attempts).',
                      style: AppText.meta(AppColors.warningFg),
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  // -- the plan (3a) ------------------------------------------------------
  Widget _planCard(WorkflowPlan plan) => Padding(
        padding: const EdgeInsets.only(left: 36),
        child: GlassCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Execution plan', style: AppText.sectionTitle()),
              const SizedBox(height: 2),
              Text(
                '${plan.plan.length} steps · nothing runs until you confirm',
                style: AppText.meta(),
              ),
              const SizedBox(height: 12),
              for (var i = 0; i < plan.plan.length; i++)
                _planStep(plan.plan[i], i == plan.plan.length - 1),
            ],
          ),
        ),
      );

  Widget _planStep(PlannedStep step, bool isLast) => Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Column(
            children: [
              Container(
                width: 22,
                height: 22,
                decoration: BoxDecoration(
                  color: AppColors.ice,
                  shape: BoxShape.circle,
                  border: Border.all(color: AppColors.glacier),
                ),
                alignment: Alignment.center,
                child: Text(
                  '${step.order}',
                  style: AppText.micro(AppColors.turquoise),
                ),
              ),
              if (!isLast)
                Container(
                  width: 2,
                  height: 24,
                  margin: const EdgeInsets.symmetric(vertical: 2),
                  color: AppColors.divider,
                ),
            ],
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Padding(
              padding: EdgeInsets.only(bottom: isLast ? 0 : 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(step.title, style: AppText.listTitle()),
                      ),
                      if (step.toolName != null)
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 7,
                            vertical: 2,
                          ),
                          decoration: BoxDecoration(
                            color: AppColors.divider,
                            borderRadius: BorderRadius.circular(AppRadii.tiny),
                          ),
                          child: Text(
                            step.toolName!,
                            style: AppText.mono(9.5, AppColors.neutralFg),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(height: 1),
                  Text(step.description, style: AppText.meta()),
                ],
              ),
            ),
          ),
        ],
      );

  // -- footers ------------------------------------------------------------
  Widget _composer() => Row(
        children: [
          Expanded(
            child: Container(
              constraints: const BoxConstraints(maxHeight: 120),
              decoration: BoxDecoration(
                color: AppColors.white,
                borderRadius: BorderRadius.circular(AppRadii.panel),
                border: Border.all(color: AppColors.glacier, width: 1.5),
              ),
              child: TextField(
                controller: _input,
                maxLines: null,
                textInputAction: TextInputAction.newline,
                style: AppText.body(),
                decoration: InputDecoration(
                  border: InputBorder.none,
                  filled: false,
                  hintText: 'Describe what you need…',
                  hintStyle: AppText.caption(AppColors.subtle),
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 14,
                  ),
                ),
                onChanged: (_) => setState(() {}),
              ),
            ),
          ),
          const SizedBox(width: 10),
          GestureDetector(
            onTap: _input.text.trim().length >= 8 ? _send : null,
            child: Opacity(
              opacity: _input.text.trim().length >= 8 ? 1 : 0.4,
              child: Container(
                width: 52,
                height: 52,
                decoration: const BoxDecoration(
                  gradient: AppGradients.cta,
                  shape: BoxShape.circle,
                  boxShadow: AppShadows.cta,
                ),
                child: const Icon(
                  Icons.arrow_upward,
                  color: AppColors.white,
                  size: 20,
                ),
              ),
            ),
          ),
        ],
      );

  Widget _confirmBar() => Row(
        children: [
          Expanded(
            child: SecondaryButton(
              label: 'Revise',
              icon: Icons.edit_outlined,
              onPressed: () => setState(() {
                _plan = null;
                _sentText = null;
              }),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            flex: 2,
            child: PrimaryButton(
              label: 'Confirm & Execute',
              busy: _starting,
              trailingIcon: Icons.arrow_forward,
              onPressed: _confirmAndRun,
            ),
          ),
        ],
      );
}
