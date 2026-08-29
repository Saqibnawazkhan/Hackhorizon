/// The Flutter ThemeData assembled from the design tokens.
///
/// The design is authored in Instrument Sans, which is BUNDLED as an asset
/// rather than fetched at runtime -- a demo must not depend on the network to
/// paint its first frame, and a font swap mid-session is visibly ugly.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'tokens.dart';

/// Named text styles, matching the design's exact sizes and weights.
///
/// The design uses only four weights (400, 500, 600, 700) and 600/700 carry
/// almost everything -- it is a deliberately bold-leaning type system.
abstract final class AppText {
  static TextStyle _base(
    double size,
    FontWeight weight,
    Color color, {
    double? height,
    double? letterSpacing,
  }) =>
      TextStyle(
        fontFamily: fontFamily,
        fontFamilyFallback: const ['Segoe UI', 'Roboto', 'SF Pro Text'],
        fontSize: size,
        fontWeight: weight,
        color: color,
        height: height,
        letterSpacing: letterSpacing,
      );

  /// The bundled family name, as declared in pubspec.yaml.
  static const fontFamily = 'InstrumentSans';

  /// Dashboard stat numerals -- 26px/700.
  static TextStyle stat(Color color) =>
      _base(AppTypeScale.stat, FontWeight.w700, color);

  /// Home greeting -- 24px/700, letter-spacing -.4px.
  static TextStyle hero(Color color) => _base(
        AppTypeScale.hero,
        FontWeight.w700,
        color,
        height: 1.25,
        letterSpacing: -0.4,
      );

  /// Screen header -- 20px/700, letter-spacing -.3px.
  static TextStyle pageTitle([Color color = AppColors.ink]) => _base(
        AppTypeScale.pageTitle,
        FontWeight.w700,
        color,
        letterSpacing: -0.3,
      );

  /// Card / section heading -- 15px/700.
  static TextStyle sectionTitle([Color color = AppColors.ink]) =>
      _base(AppTypeScale.sectionTitle, FontWeight.w700, color);

  /// List-row title -- 14px/600.
  static TextStyle listTitle([Color color = AppColors.ink]) =>
      _base(AppTypeScale.body, FontWeight.w600, color);

  /// Vendor-portal list title -- 13.5px/600.
  static TextStyle listTitleSm([Color color = AppColors.inkVendor]) =>
      _base(AppTypeScale.listTitle, FontWeight.w600, color);

  /// Body copy -- 14px/400, generous leading for chat bubbles.
  static TextStyle body([Color color = AppColors.ink]) =>
      _base(AppTypeScale.body, FontWeight.w400, color, height: 1.5);

  /// Justification / explanatory copy -- 12.5px/400, height 1.55.
  static TextStyle explain([Color color = AppColors.successFg]) =>
      _base(AppTypeScale.label, FontWeight.w400, color, height: 1.55);

  /// Metadata rows -- 12px/400.
  static TextStyle caption([Color color = AppColors.muted]) =>
      _base(AppTypeScale.caption, FontWeight.w400, color);

  /// Emphasised value inside a metadata row -- 12px/700.
  static TextStyle captionStrong([Color color = AppColors.ink]) =>
      _base(AppTypeScale.caption, FontWeight.w700, color);

  /// Timestamps and secondary meta -- 11px/400.
  static TextStyle meta([Color color = AppColors.subtle]) =>
      _base(AppTypeScale.captionSm, FontWeight.w400, color);

  /// Status pill label -- 11px/600.
  static TextStyle pill([Color color = AppColors.neutralFg]) =>
      _base(AppTypeScale.captionSm, FontWeight.w600, color);

  /// Entity chip -- 11.5px/600.
  static TextStyle chip([Color color = AppColors.turquoise]) =>
      _base(AppTypeScale.chip, FontWeight.w600, color);

  /// Badge -- 10.5px/700 ("Best Option").
  static TextStyle badge([Color color = AppColors.white]) =>
      _base(AppTypeScale.badge, FontWeight.w700, color);

  /// Legend / micro-label -- 10px/600.
  static TextStyle micro([Color color = AppColors.muted]) =>
      _base(AppTypeScale.micro, FontWeight.w600, color);

  /// Primary button label -- 15px/600.
  static TextStyle button([Color color = AppColors.white]) =>
      _base(AppTypeScale.sectionTitle, FontWeight.w600, color);

  /// Monospace, used for ids and audit references.
  static TextStyle mono(double size, [Color color = AppColors.muted]) =>
      TextStyle(
        fontFamily: 'monospace',
        fontFamilyFallback: const ['Menlo', 'Consolas', 'Roboto Mono'],
        fontSize: size,
        fontWeight: FontWeight.w500,
        color: color,
      );
}

abstract final class AppTheme {
  /// The design has no dark variant. Rather than invent one, the app commits
  /// to the light palette and pins the system chrome to match, so a device in
  /// dark mode still renders the design as drawn.
  static ThemeData light() {
    final base = ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      scaffoldBackgroundColor: AppColors.white,
      colorScheme: const ColorScheme.light(
        primary: AppColors.turquoise,
        onPrimary: AppColors.white,
        secondary: AppColors.slate,
        onSecondary: AppColors.white,
        surface: AppColors.white,
        onSurface: AppColors.ink,
        error: AppColors.dangerFg,
        onError: AppColors.white,
        outline: AppColors.divider,
      ),
    );

    return base.copyWith(
      textTheme: base.textTheme.apply(
        fontFamily: AppText.fontFamily,
        bodyColor: AppColors.ink,
        displayColor: AppColors.ink,
      ),
      splashFactory: InkSparkle.splashFactory,
      appBarTheme: const AppBarTheme(
        backgroundColor: Colors.transparent,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        centerTitle: false,
        systemOverlayStyle: SystemUiOverlayStyle(
          statusBarColor: Colors.transparent,
          statusBarIconBrightness: Brightness.dark,
          statusBarBrightness: Brightness.light,
        ),
      ),
      dividerTheme: const DividerThemeData(
        color: AppColors.divider,
        thickness: 1,
        space: 1,
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: AppColors.ink,
        contentTextStyle: AppText.caption(AppColors.white),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadii.control),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: AppColors.inputFill,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.xxl,
          vertical: AppSpacing.xl,
        ),
        hintStyle: AppText.caption(AppColors.subtle),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadii.field),
          borderSide: const BorderSide(color: AppColors.glacier, width: 1.5),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadii.field),
          borderSide: const BorderSide(color: AppColors.glacier, width: 1.5),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadii.field),
          borderSide: const BorderSide(color: AppColors.turquoise, width: 1.5),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadii.field),
          borderSide: const BorderSide(color: AppColors.dangerFg, width: 1.5),
        ),
      ),
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: {
          TargetPlatform.android: CupertinoPageTransitionsBuilder(),
          TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        },
      ),
    );
  }
}
