/// Loads the bundled Instrument Sans into the test harness.
///
/// `flutter test` renders every glyph as an Ahem block by default, which makes
/// a golden useless for reviewing a DESIGN -- you can check boxes and shadows
/// but not type. Registering the real font turns goldens into something worth
/// looking at.
library;

import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

bool _loaded = false;

/// Call once from `setUpAll` in any golden test.
Future<void> loadAppFonts() async {
  if (_loaded) return;
  TestWidgetsFlutterBinding.ensureInitialized();

  const weights = {
    'assets/fonts/InstrumentSans-400.ttf': FontWeight.w400,
    'assets/fonts/InstrumentSans-500.ttf': FontWeight.w500,
    'assets/fonts/InstrumentSans-600.ttf': FontWeight.w600,
    'assets/fonts/InstrumentSans-700.ttf': FontWeight.w700,
  };

  // A FontLoader maps one family name to its faces. Flutter picks the nearest
  // weight, so all four are registered under the same family.
  final loader = FontLoader('InstrumentSans');
  for (final path in weights.keys) {
    final file = File(path);
    if (!file.existsSync()) continue;
    loader.addFont(
      Future.value(file.readAsBytesSync().buffer.asByteData()),
    );
  }
  await loader.load();

  // Material icons render as empty squares in the harness unless the icon
  // font is registered too, which makes a golden much harder to read.
  final iconFont = File(
    '${_flutterRoot()}/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
  );
  if (iconFont.existsSync()) {
    final icons = FontLoader('MaterialIcons')
      ..addFont(
        Future.value(iconFont.readAsBytesSync().buffer.asByteData()),
      );
    await icons.load();
  }

  // The harness has no system monospace, so AppText.mono renders as tofu in
  // goldens. Register the bundled face under that family name too -- test
  // only; on a real device the platform monospace resolves normally.
  final monoSrc = File('assets/fonts/InstrumentSans-500.ttf');
  if (monoSrc.existsSync()) {
    final mono = FontLoader('monospace')
      ..addFont(
        Future.value(monoSrc.readAsBytesSync().buffer.asByteData()),
      );
    await mono.load();
  }

  _loaded = true;
}

/// Locate the Flutter SDK so the bundled icon font can be found.
String _flutterRoot() {
  final env = Platform.environment['FLUTTER_ROOT'];
  if (env != null && env.isNotEmpty) return env;
  // dart executable lives at <root>/bin/cache/dart-sdk/bin/dart
  final exe = Platform.resolvedExecutable;
  final marker = '${Platform.pathSeparator}bin${Platform.pathSeparator}cache';
  final idx = exe.indexOf(marker);
  return idx == -1 ? '' : exe.substring(0, idx);
}
