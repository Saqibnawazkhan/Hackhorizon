/// The two surface treatments the design uses, as reusable widgets.
///
/// THE MIX IS DELIBERATE. The design is not inconsistent -- it applies liquid
/// glass to the buyer-facing flows and claymorphism to the vendor portal
/// (screen 14d is 14a redrawn in clay). Both are reproduced faithfully rather
/// than normalised to one look.
///
/// FLUTTER HAS NO INSET BOX-SHADOW. The design leans on inset shadows for
/// both recipes:
///
///   glass: `inset 0 1px 0 rgba(255,255,255,.95)` -- a 1px lit top edge
///          `inset 0 -1px 1px rgba(255,255,255,.3)` -- a faint lit bottom edge
///   clay:  `inset 0 10px 14px rgba(255,255,255,.95)` -- a broad lit top
///          `inset 0 -10px 18px rgba(68,127,152,.13)` -- a broad shaded bottom
///
/// Both are reproduced with a gradient painted INSIDE the clipped surface: a
/// vertical gradient from a light top to a shaded bottom is visually what an
/// inset shadow pair produces. For the glass 1px edge a hairline border
/// gradient is closer than a full-height gradient, so it is drawn separately.
library;

import 'dart:ui';

import 'package:flutter/material.dart';

import 'tokens.dart';

/// Liquid glass. The dominant surface across employee and admin screens.
///
/// `background: linear-gradient(135deg, rgba(255,255,255,.62), rgba(255,255,255,.22))`
/// `backdrop-filter: blur(26px) saturate(1.7)`
/// `border: 1px solid rgba(255,255,255,.8)`
/// `box-shadow: 0 20px 44px rgba(46,96,120,.24) + 2 inset highlights`
class GlassCard extends StatelessWidget {
  const GlassCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(AppSpacing.xxl),
    this.radius = AppRadii.card,
    this.blur = AppBlurs.card,
    this.saturation = AppBlurs.cardSaturation,
    this.gradient = AppGradients.glass,
    this.shadows = AppShadows.glassCard,
    this.borderColor = const Color(0xCCFFFFFF),
    this.onTap,
    this.margin,
    this.width,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final double radius;
  final double blur;
  final double saturation;
  final Gradient gradient;
  final List<BoxShadow> shadows;
  final Color borderColor;
  final VoidCallback? onTap;
  final EdgeInsetsGeometry? margin;
  final double? width;

  @override
  Widget build(BuildContext context) {
    final border = BorderRadius.circular(radius);

    Widget surface = _OuterShadow(
      borderRadius: border,
      shadows: shadows,
      child: ClipRRect(
        borderRadius: border,
        child: BackdropFilter(
          filter: ImageFilter.compose(
            outer: ImageFilter.blur(sigmaX: blur / 2, sigmaY: blur / 2),
            inner: ColorFilter.matrix(_saturate(saturation)),
          ),
          child: Container(
            width: width,
            decoration: BoxDecoration(
              gradient: gradient,
              borderRadius: border,
              border: Border.all(color: borderColor, width: 1),
            ),
            child: Stack(
              children: [
                // Stands in for the two inset highlights.
                Positioned.fill(
                  child: IgnorePointer(
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        borderRadius: border,
                        gradient: const LinearGradient(
                          begin: Alignment.topCenter,
                          end: Alignment.bottomCenter,
                          colors: [
                            Color(0x40FFFFFF),
                            Color(0x00FFFFFF),
                            Color(0x14FFFFFF),
                          ],
                          stops: [0.0, 0.18, 1.0],
                        ),
                      ),
                    ),
                  ),
                ),
                Padding(padding: padding, child: child),
              ],
            ),
          ),
        ),
      ),
    );

    if (onTap != null) {
      surface = Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: border,
          onTap: onTap,
          child: surface,
        ),
      );
    }
    return margin == null ? surface : Padding(padding: margin!, child: surface);
  }
}

/// Claymorphism. The vendor-portal treatment (screen 14d).
///
/// `background: #F2F7FA`
/// `border-radius: 30px`
/// `box-shadow: 0 22px 30px rgba(68,127,152,.16),`
/// `            inset 0 -10px 18px rgba(68,127,152,.13),`
/// `            inset 0 10px 14px rgba(255,255,255,.95)`
///
/// No backdrop blur: clay is opaque. The extruded look comes entirely from the
/// outer shadow plus the lit-top / shaded-bottom pair, which is reproduced
/// here as an inner vertical gradient.
class ClayCard extends StatelessWidget {
  const ClayCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(AppSpacing.xxl),
    this.radius = AppRadii.clayCard,
    this.color = AppColors.clayBase,
    this.shadows = AppShadows.clayCard,
    this.onTap,
    this.margin,
    this.recessed = false,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final double radius;
  final Color color;
  final List<BoxShadow> shadows;
  final VoidCallback? onTap;
  final EdgeInsetsGeometry? margin;

  /// Inverts the lighting so the surface reads as pressed IN rather than
  /// raised -- the design uses this for the price field on 14d.
  final bool recessed;

  @override
  Widget build(BuildContext context) {
    final border = BorderRadius.circular(radius);

    Widget surface = DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: border,
        // A recessed element casts no outer shadow.
        boxShadow: recessed ? const [] : shadows,
      ),
      child: ClipRRect(
        borderRadius: border,
        child: Container(
          color: color,
          child: Stack(
            children: [
              Positioned.fill(
                child: IgnorePointer(
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: recessed
                          // shaded top, lit bottom -- pressed in
                          ? const LinearGradient(
                              begin: Alignment.topCenter,
                              end: Alignment.bottomCenter,
                              colors: [
                                Color(0x2E447F98),
                                Color(0x00447F98),
                                Color(0xE6FFFFFF),
                              ],
                              stops: [0.0, 0.45, 1.0],
                            )
                          // lit top, shaded bottom -- raised
                          : const LinearGradient(
                              begin: Alignment.topCenter,
                              end: Alignment.bottomCenter,
                              colors: [
                                Color(0xF2FFFFFF),
                                Color(0x00FFFFFF),
                                Color(0x21447F98),
                              ],
                              stops: [0.0, 0.35, 1.0],
                            ),
                    ),
                  ),
                ),
              ),
              Padding(padding: padding, child: child),
            ],
          ),
        ),
      ),
    );

    if (onTap != null) {
      surface = Material(
        color: Colors.transparent,
        child: InkWell(borderRadius: border, onTap: onTap, child: surface),
      );
    }
    return margin == null ? surface : Padding(padding: margin!, child: surface);
  }
}

/// A solid card with a coloured outline -- the "Best Option" winner on 5a/11a.
///
/// `background: #fff; border: 1.5px solid #17B26A; box-shadow: 0 8px 22px rgba(46,96,120,.05)`
class OutlinedSurface extends StatelessWidget {
  const OutlinedSurface({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.symmetric(
      horizontal: AppSpacing.xxl,
      vertical: AppSpacing.xl,
    ),
    this.radius = AppRadii.panel,
    this.borderColor = AppColors.successSolid,
    this.borderWidth = 1.5,
    this.color = AppColors.white,
    this.onTap,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final double radius;
  final Color borderColor;
  final double borderWidth;
  final Color color;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final border = BorderRadius.circular(radius);
    final surface = Container(
      decoration: BoxDecoration(
        color: color,
        borderRadius: border,
        border: Border.all(color: borderColor, width: borderWidth),
        boxShadow: AppShadows.flat,
      ),
      padding: padding,
      child: child,
    );
    if (onTap == null) return surface;
    return Material(
      color: Colors.transparent,
      child: InkWell(borderRadius: border, onTap: onTap, child: surface),
    );
  }
}

/// A de-emphasised glass card -- the budget-excluded supplier on 5a/11a.
///
/// `background: rgba(255,255,255,.55); backdrop-filter: blur(14px);`
/// `border: 1px solid #FECDCA; opacity: .8`
class MutedSurface extends StatelessWidget {
  const MutedSurface({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.symmetric(
      horizontal: AppSpacing.xxl,
      vertical: AppSpacing.xl,
    ),
    this.radius = AppRadii.panel,
    this.borderColor = AppColors.dangerBorder,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final double radius;
  final Color borderColor;

  @override
  Widget build(BuildContext context) {
    final border = BorderRadius.circular(radius);
    return Opacity(
      opacity: 0.8,
      child: DecoratedBox(
        decoration: BoxDecoration(borderRadius: border, boxShadow: AppShadows.flat),
        child: ClipRRect(
          borderRadius: border,
          child: BackdropFilter(
            filter: ImageFilter.blur(
              sigmaX: AppBlurs.soft / 2,
              sigmaY: AppBlurs.soft / 2,
            ),
            child: Container(
              decoration: BoxDecoration(
                color: const Color(0x8CFFFFFF),
                borderRadius: border,
                border: Border.all(color: borderColor),
              ),
              padding: padding,
              child: child,
            ),
          ),
        ),
      ),
    );
  }
}

/// The page background: white with two soft radial washes.
///
/// `radial-gradient(360px 360px at 88% -6%, rgba(68,127,152,.18), transparent 62%)`
/// `radial-gradient(320px 320px at -12% 80%, rgba(98,155,182,.14), transparent 65%)`
class PageBackground extends StatelessWidget {
  const PageBackground({super.key, required this.child, this.vendor = false});

  final Widget child;

  /// Vendor screens in clay use a flat white ground instead of the washes.
  final bool vendor;

  @override
  Widget build(BuildContext context) {
    if (vendor) {
      return ColoredBox(color: AppColors.white, child: child);
    }
    return Stack(
      children: [
        const Positioned.fill(child: ColoredBox(color: AppColors.white)),
        Positioned.fill(
          child: IgnorePointer(
            child: DecoratedBox(
              decoration: const BoxDecoration(
                gradient: RadialGradient(
                  center: Alignment(0.76, -1.12),
                  radius: 0.95,
                  colors: [Color(0x2E447F98), Color(0x00447F98)],
                  stops: [0.0, 0.62],
                ),
              ),
            ),
          ),
        ),
        Positioned.fill(
          child: IgnorePointer(
            child: DecoratedBox(
              decoration: const BoxDecoration(
                gradient: RadialGradient(
                  center: Alignment(-1.24, 0.6),
                  radius: 0.85,
                  colors: [Color(0x24629BB5), Color(0x00629BB5)],
                  stops: [0.0, 0.65],
                ),
              ),
            ),
          ),
        ),
        child,
      ],
    );
  }
}

/// Draws a drop shadow OUTSIDE the shape only, as CSS does.
///
/// Flutter's `BoxShadow` paints a blurred silhouette behind the entire box.
/// Under an opaque surface that is invisible and harmless, but under a
/// TRANSLUCENT one -- which is the whole point of liquid glass -- the shadow
/// shows through and the card reads muddy grey instead of luminous.
///
/// CSS clips an outer box-shadow to the region outside the border-box. This
/// reproduces that: the shadow layer is painted with the shape itself punched
/// out, so only the halo around the card survives.
class _OuterShadow extends StatelessWidget {
  const _OuterShadow({
    required this.child,
    required this.borderRadius,
    required this.shadows,
  });

  final Widget child;
  final BorderRadius borderRadius;
  final List<BoxShadow> shadows;

  @override
  Widget build(BuildContext context) {
    if (shadows.isEmpty) return child;
    return CustomPaint(
      painter: _OuterShadowPainter(borderRadius, shadows),
      child: child,
    );
  }
}

class _OuterShadowPainter extends CustomPainter {
  const _OuterShadowPainter(this.borderRadius, this.shadows);

  final BorderRadius borderRadius;
  final List<BoxShadow> shadows;

  @override
  void paint(Canvas canvas, Size size) {
    final rrect = borderRadius.toRRect(Offset.zero & size);

    // Clip to everything EXCEPT the card, sized to the widest shadow so no
    // halo is cut short.
    final reach = shadows.fold<double>(
      0,
      (m, s) => [
        m,
        s.blurRadius + s.spreadRadius + s.offset.dx.abs() + s.offset.dy.abs(),
      ].reduce((a, b) => a > b ? a : b),
    );
    canvas.save();
    canvas.clipPath(
      Path.combine(
        PathOperation.difference,
        Path()
          ..addRect(
            Rect.fromLTRB(
              -reach,
              -reach,
              size.width + reach,
              size.height + reach,
            ),
          ),
        Path()..addRRect(rrect),
      ),
    );
    for (final shadow in shadows) {
      canvas.drawRRect(
        rrect.shift(shadow.offset).inflate(shadow.spreadRadius),
        Paint()
          ..color = shadow.color
          ..maskFilter = MaskFilter.blur(
            BlurStyle.normal,
            // CSS blur-radius is roughly 2x a Gaussian sigma.
            shadow.blurRadius / 2,
          ),
      );
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_OuterShadowPainter old) =>
      old.borderRadius != borderRadius || old.shadows != shadows;
}

/// Saturation matrix for `backdrop-filter: saturate(n)`.
List<double> _saturate(double s) {
  const lr = 0.213, lg = 0.715, lb = 0.072;
  final sr = (1 - s) * lr, sg = (1 - s) * lg, sb = (1 - s) * lb;
  return <double>[
    sr + s, sg,      sb,      0, 0,
    sr,     sg + s,  sb,      0, 0,
    sr,     sg,      sb + s,  0, 0,
    0,      0,       0,       1, 0,
  ];
}
