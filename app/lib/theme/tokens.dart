/// Design tokens extracted from AgentFlow.dc.html.
///
/// Every value here appears verbatim in the design file. Nothing is invented
/// and nothing is rounded: where the design uses 13.5px, so do we. Screens
/// never hard-code a colour, radius, blur or shadow -- they read from here, so
/// a change lands everywhere at once.
///
/// The design deliberately mixes TWO surface treatments and this file keeps
/// both, unnormalised:
///
///   liquid glass -- translucent white gradient, backdrop blur + saturation,
///                   a 1px white border, a large soft drop shadow and inset
///                   highlights. Used across the employee and admin flows.
///
///   claymorphism -- opaque pale surface, no blur, large soft outer shadow
///                   plus strong inset shading top and bottom to look
///                   extruded. Used in the vendor portal (screen 14d).
library;

import 'package:flutter/material.dart';

// ===========================================================================
// Colour
// ===========================================================================
abstract final class AppColors {
  // -- Vendor palette (as stated in the brief) ------------------------------
  /// Turquoise. Primary brand colour, 87 uses in the design.
  static const turquoise = Color(0xFF447F98);

  /// Slate. Secondary accent; the middle segment of the score bar.
  static const slate = Color(0xFF629BB5);

  /// Platinum. Neutral chip background.
  static const platinum = Color(0xFFDADEE1);

  /// Glacier. The lightest score-bar segment and glass card borders.
  static const glacier = Color(0xFFB9D8E1);

  /// Ice. Info-banner fill and the "In Progress" pill background.
  static const ice = Color(0xFFD6EBF3);

  // -- Text -----------------------------------------------------------------
  /// Primary body text on employee screens.
  static const ink = Color(0xFF243640);

  /// Primary body text on vendor screens (very slightly warmer).
  static const inkVendor = Color(0xFF2E3E47);

  /// Headings on light chrome; also the back-chevron stroke.
  static const inkStrong = Color(0xFF101828);

  /// Secondary text: labels, metadata rows.
  static const muted = Color(0xFF5F7280);

  /// Tertiary text: timestamps, captions. The most-used colour in the design.
  static const subtle = Color(0xFF7E8C94);

  /// Neutral pill text.
  static const neutralText = Color(0xFF4A5C66);

  /// Agent chat-bubble text.
  static const bubbleText = Color(0xFF3E505A);

  /// Deep turquoise, used for text on ice backgrounds.
  static const deepTurquoise = Color(0xFF38677B);

  /// Muted turquoise for low-stock and de-emphasised numerics.
  static const dimTurquoise = Color(0xFF3F6B80);

  static const disabled = Color(0xFFB3C4CC);

  // -- Surfaces -------------------------------------------------------------
  static const white = Color(0xFFFFFFFF);

  /// Hairline dividers and the score-bar track.
  static const divider = Color(0xFFE7EFF3);
  static const dividerAlt = Color(0xFFE3EBEF);
  static const dividerSoft = Color(0xFFDCE9EF);

  /// Claymorphism base surface (screen 14d).
  static const clayBase = Color(0xFFF2F7FA);

  /// Recessed clay input fill.
  static const clayRecess = Color(0xFFDDEDF4);

  /// Glass input fill.
  static const inputFill = Color(0xFFE9F3F8);

  // -- Status -------------------------------------------------------------
  static const successBg = Color(0xFFECFDF3);
  static const successFg = Color(0xFF067647);
  static const successBorder = Color(0xFFA6F4C5);

  /// The solid "Best Option" badge fill.
  static const successSolid = Color(0xFF17B26A);

  static const warningBg = Color(0xFFFFFAEB);
  static const warningFg = Color(0xFFB54708);
  static const warningBorder = Color(0xFFFEDF89);

  static const dangerBg = Color(0xFFFEF3F2);
  static const dangerFg = Color(0xFFB42318);
  static const dangerBorder = Color(0xFFFECDCA);

  static const neutralBg = Color(0xFFE7EFF3);
  static const neutralFg = Color(0xFF4A5C66);

  // -- Shadow tints ---------------------------------------------------------
  /// Glass drop shadows are tinted with this, not neutral black.
  static const glassShadowTint = Color(0xFF2E6078); // rgb(46,96,120)

  /// Clay shadows use the turquoise itself.
  static const clayShadowTint = Color(0xFF447F98); // rgb(68,127,152)
}

// ===========================================================================
// Gradients
// ===========================================================================
abstract final class AppGradients {
  /// The primary CTA / avatar / user chat-bubble fill.
  /// `linear-gradient(160deg, rgba(116,176,200,.95), rgba(52,104,128,.94))`
  ///
  /// 160deg in CSS runs top-ish to bottom-ish; Flutter's equivalent is
  /// roughly topCenter -> bottomRight.
  static const cta = LinearGradient(
    begin: Alignment(-0.34, -1.0),
    end: Alignment(0.34, 1.0),
    colors: [Color(0xF274B0C8), Color(0xEF346880)],
  );

  /// Opaque hero card on the home screen. `linear-gradient(160deg,#4A83A0,#27485A)`
  static const hero = LinearGradient(
    begin: Alignment(-0.34, -1.0),
    end: Alignment(0.34, 1.0),
    colors: [Color(0xFF4A83A0), Color(0xFF27485A)],
  );

  /// Liquid-glass surface fill.
  /// `linear-gradient(135deg, rgba(255,255,255,.62), rgba(255,255,255,.22))`
  static const glass = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0x9EFFFFFF), Color(0x38FFFFFF)],
  );

  /// Lighter glass, used on the nav bar and secondary chrome.
  static const glassSoft = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xCCFFFFFF), Color(0x80FFFFFF)],
  );

  /// The agent avatar dot. `linear-gradient(135deg,#447F98,#629BB5)`
  static const avatar = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [AppColors.turquoise, AppColors.slate],
  );
}

// ===========================================================================
// Radii
// ===========================================================================
abstract final class AppRadii {
  /// Fully rounded. The design writes both 99px and 999px; identical in effect.
  static const pill = 999.0;

  /// The dominant card radius (36 uses).
  static const card = 28.0;

  /// Clay card radius (screen 14d uses a slightly larger 30).
  static const clayCard = 30.0;

  static const panel = 24.0;
  static const banner = 20.0;
  static const control = 16.0;
  static const field = 14.0;
  static const chip = 8.0;
  static const tiny = 6.0;
  static const swatch = 2.0;

  static BorderRadius all(double r) => BorderRadius.circular(r);
}

// ===========================================================================
// Blur
// ===========================================================================
abstract final class AppBlurs {
  /// Primary glass card: `blur(26px) saturate(1.7)`.
  static const card = 26.0;
  static const cardSaturation = 1.7;

  /// Nav bar: `blur(20px) saturate(1.6)`.
  static const nav = 20.0;
  static const navSaturation = 1.6;

  /// Sheets and headers: `blur(18px) saturate(1.5)`.
  static const sheet = 18.0;
  static const sheetSaturation = 1.5;

  /// Small chrome (pills, avatars, CTA): `blur(12px)`.
  static const chip = 12.0;

  /// De-emphasised / excluded cards: `blur(14px)`.
  static const soft = 14.0;
}

// ===========================================================================
// Shadows
// ===========================================================================
abstract final class AppShadows {
  /// The signature glass card drop shadow.
  /// `0 20px 44px rgba(46,96,120,.24)`
  ///
  /// The design pairs this with two INSET highlights. Flutter has no inset
  /// shadow, so `GlassCard` reproduces them with a gradient overlay instead --
  /// see `surfaces.dart`.
  static const glassCard = <BoxShadow>[
    BoxShadow(
      color: Color(0x3D2E6078),
      blurRadius: 44,
      offset: Offset(0, 20),
    ),
  ];

  /// Primary CTA button. `0 18px 36px rgba(46,96,120,.35)`
  static const cta = <BoxShadow>[
    BoxShadow(
      color: Color(0x592E6078),
      blurRadius: 36,
      offset: Offset(0, 18),
    ),
  ];

  /// Nav bar. `0 12px 28px rgba(46,96,120,.18)`
  static const nav = <BoxShadow>[
    BoxShadow(
      color: Color(0x2E2E6078),
      blurRadius: 28,
      offset: Offset(0, 12),
    ),
  ];

  /// Hero card. `0 14px 30px rgba(46,96,120,.18)`
  static const hero = <BoxShadow>[
    BoxShadow(
      color: Color(0x2E2E6078),
      blurRadius: 30,
      offset: Offset(0, 14),
    ),
  ];

  /// Flat outlined cards (the winner card on 5a). `0 8px 22px rgba(46,96,120,.05)`
  static const flat = <BoxShadow>[
    BoxShadow(
      color: Color(0x0D2E6078),
      blurRadius: 22,
      offset: Offset(0, 8),
    ),
  ];

  /// Claymorphism outer shadow. `0 22px 30px rgba(68,127,152,.16)`
  static const clayCard = <BoxShadow>[
    BoxShadow(
      color: Color(0x29447F98),
      blurRadius: 30,
      offset: Offset(0, 22),
    ),
  ];

  /// Smaller clay elements. `0 8px 14px rgba(68,127,152,.16)`
  static const claySmall = <BoxShadow>[
    BoxShadow(
      color: Color(0x29447F98),
      blurRadius: 14,
      offset: Offset(0, 8),
    ),
  ];

  /// Success toast. `0 8px 20px rgba(7,148,85,.28)`
  static const success = <BoxShadow>[
    BoxShadow(
      color: Color(0x47079455),
      blurRadius: 20,
      offset: Offset(0, 8),
    ),
  ];
}

// ===========================================================================
// Spacing
// ===========================================================================
abstract final class AppSpacing {
  /// Horizontal page padding. The design alternates 16 and 20; 20 dominates.
  static const page = 20.0;
  static const pageTight = 16.0;

  static const xs = 4.0;
  static const sm = 6.0;
  static const md = 8.0;
  static const lg = 10.0;
  static const xl = 12.0;
  static const xxl = 14.0;
  static const xxxl = 16.0;
  static const section = 18.0;
  static const block = 20.0;

  /// Gap between stacked cards in a scroll column.
  static const cardGap = 12.0;

  /// The design's status-bar clearance (58px) is chrome from the iOS frame
  /// mock, NOT a real inset. Screens use MediaQuery padding instead; this is
  /// kept only to document the source value.
  static const mockStatusBar = 58.0;
}

// ===========================================================================
// Type scale
// ===========================================================================
abstract final class AppTypeScale {
  static const stat = 26.0;        // dashboard stat numbers
  static const hero = 24.0;        // home greeting
  static const pageTitle = 20.0;   // screen headers
  static const sectionTitle = 15.0;
  static const body = 14.0;
  static const listTitle = 13.5;
  static const bodySm = 13.0;
  static const label = 12.5;
  static const caption = 12.0;
  static const chip = 11.5;
  static const captionSm = 11.0;
  static const badge = 10.5;
  static const micro = 10.0;
  static const nano = 9.5;
}
