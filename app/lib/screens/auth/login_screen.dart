/// Sign-in.
///
/// The design ships a VENDOR login (screen 16a) but no employee or admin
/// login. This screen is generated in the same style and palette: the same
/// glass card, the same gradient CTA, the same type scale -- with a role
/// selector so one screen serves all three, and a vendor variant that matches
/// 16a's copy and framing.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/models.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../theme/surfaces.dart';
import '../../theme/tokens.dart';
import '../../widgets/common.dart';
import '../../widgets/shell.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key, this.initialRole = UserRole.employee});

  final UserRole initialRole;

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _formKey = GlobalKey<FormState>();
  late UserRole _role = widget.initialRole;
  bool _obscure = true;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  bool get _isVendor => _role == UserRole.vendor;

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    final ok = await ref
        .read(authProvider.notifier)
        .signIn(_email.text, _password.text);
    if (!mounted) return;
    if (!ok) {
      final err = ref.read(authProvider).error;
      showToast(context, err ?? 'Sign-in failed', danger: true);
    }
  }

  /// Demo accounts, so the app is usable without typing credentials.
  void _fill(String email) {
    _email.text = email;
    _password.text = 'AgentFlow!2026';
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authProvider);

    return Scaffold(
      backgroundColor: Colors.transparent,
      resizeToAvoidBottomInset: true,
      body: PageBackground(
        vendor: _isVendor,
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(24, 40, 24, 24),
            children: [
              // -- brand -------------------------------------------------
              Center(
                child: Container(
                  width: 62,
                  height: 62,
                  decoration: BoxDecoration(
                    gradient: AppGradients.cta,
                    borderRadius: BorderRadius.circular(20),
                    boxShadow: AppShadows.cta,
                  ),
                  child: const Icon(
                    Icons.auto_awesome,
                    color: AppColors.white,
                    size: 28,
                  ),
                ),
              ),
              const SizedBox(height: 18),
              Center(child: Text('AgentFlow', style: AppText.pageTitle())),
              const SizedBox(height: 4),
              Center(
                child: Text(
                  _isVendor
                      ? 'Vendor portal — manage your catalog'
                      : 'Autonomous business workflows',
                  style: AppText.caption(),
                ),
              ),
              const SizedBox(height: 26),

              // -- role selector -----------------------------------------
              Row(
                children: [
                  for (final r in UserRole.values) ...[
                    Expanded(
                      child: FilterChipButton(
                        label: switch (r) {
                          UserRole.employee => 'Employee',
                          UserRole.admin => 'Admin',
                          UserRole.vendor => 'Vendor',
                        },
                        selected: _role == r,
                        onTap: () => setState(() => _role = r),
                      ),
                    ),
                    if (r != UserRole.values.last) const SizedBox(width: 8),
                  ],
                ],
              ),
              const SizedBox(height: 18),

              // -- form ---------------------------------------------------
              _card(
                child: Form(
                  key: _formKey,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        _isVendor ? 'Vendor sign in' : 'Sign in',
                        style: AppText.sectionTitle(),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        _isVendor
                            ? 'Vendors see only their own catalog and orders.'
                            : 'Use your organisation account.',
                        style: AppText.caption(),
                      ),
                      const SizedBox(height: 16),
                      _label('Email'),
                      TextFormField(
                        controller: _email,
                        keyboardType: TextInputType.emailAddress,
                        autocorrect: false,
                        decoration: const InputDecoration(
                          hintText: 'you@company.com',
                        ),
                        validator: (v) => (v == null || !v.contains('@'))
                            ? 'Enter a valid email'
                            : null,
                      ),
                      const SizedBox(height: 12),
                      _label('Password'),
                      TextFormField(
                        controller: _password,
                        obscureText: _obscure,
                        decoration: InputDecoration(
                          hintText: '••••••••',
                          suffixIcon: IconButton(
                            icon: Icon(
                              _obscure
                                  ? Icons.visibility_outlined
                                  : Icons.visibility_off_outlined,
                              size: 19,
                              color: AppColors.subtle,
                            ),
                            onPressed: () =>
                                setState(() => _obscure = !_obscure),
                          ),
                        ),
                        validator: (v) => (v == null || v.length < 6)
                            ? 'At least 6 characters'
                            : null,
                        onFieldSubmitted: (_) => _submit(),
                      ),
                      if (auth.error != null) ...[
                        const SizedBox(height: 12),
                        InfoBanner(
                          message: auth.error!,
                          tone: PillTone.danger,
                          icon: Icons.error_outline,
                        ),
                      ],
                      const SizedBox(height: 18),
                      PrimaryButton(
                        label: 'Sign in',
                        busy: auth.loading,
                        trailingIcon: Icons.arrow_forward,
                        onPressed: _submit,
                      ),
                    ],
                  ),
                ),
              ),

              const SizedBox(height: 18),

              // -- demo accounts -----------------------------------------
              _card(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Demo accounts', style: AppText.listTitle()),
                    const SizedBox(height: 8),
                    _demoRow('Employee', 'sara@agentflow.demo'),
                    _demoRow('Admin', 'admin@agentflow.demo'),
                    _demoRow('Vendor', 'vendor@techsupplies.demo'),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// Vendor screens use clay, buyer screens use glass -- same as the design's
  /// split between 14d and the rest.
  Widget _card({required Widget child}) => _isVendor
      ? ClayCard(padding: const EdgeInsets.all(18), child: child)
      : GlassCard(padding: const EdgeInsets.all(18), child: child);

  Widget _label(String text) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text(text, style: AppText.captionStrong(AppColors.muted)),
      );

  Widget _demoRow(String role, String email) => InkWell(
        onTap: () => _fill(email),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Row(
            children: [
              SizedBox(
                width: 72,
                child: Text(role, style: AppText.caption()),
              ),
              Expanded(
                child: Text(email, style: AppText.mono(11, AppColors.turquoise)),
              ),
              const Icon(Icons.north_west, size: 13, color: AppColors.subtle),
            ],
          ),
        ),
      );
}
