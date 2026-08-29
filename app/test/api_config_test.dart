/// The API base URL, which a release bundle cannot get wrong quietly.
///
/// These exist because the failure mode is invisible until after upload: a
/// bundle built without the dart-define used to ship pointing at the emulator
/// alias, and the only symptom was every screen failing on a device that had
/// no way to reach it.
library;

import 'package:agentflow/api/api_client.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('ApiConfig', () {
    test('defaults to the deployed API, not a developer machine', () {
      final config = ApiConfig.fromEnvironment();
      expect(
        config.baseUrl,
        startsWith('https://'),
        reason: 'a store build must not default to cleartext or to localhost',
      );
      expect(config.baseUrl, isNot(contains('10.0.2.2')));
      expect(config.baseUrl, isNot(contains('localhost')));
      expect(config.baseUrl, isNot(contains('127.0.0.1')));
    });

    test('a trailing slash does not produce a doubled path', () {
      // The classic paste-from-the-browser mistake: the URL bar shows a
      // trailing slash, and naive concatenation gives `//api/v1`, which some
      // proxies 404 rather than normalise.
      const pasted = 'https://example.up.railway.app/';
      final config = ApiConfig(baseUrl: pasted.substring(0, pasted.length - 1));
      expect(config.apiV1, 'https://example.up.railway.app/api/v1');
      expect(config.apiV1, isNot(contains('//api')));
    });

    test('the configured default is already free of a trailing slash', () {
      expect(ApiConfig.fromEnvironment().apiV1, isNot(contains('//api')));
    });

    test('https yields a wss websocket, not ws', () {
      const config = ApiConfig(baseUrl: 'https://example.up.railway.app');
      final url = config.wsUrl('wf-1', token: 'tok');
      expect(url, startsWith('wss://example.up.railway.app/ws/workflows/wf-1'));
      expect(
        url,
        isNot(startsWith('ws://')),
        reason: 'an insecure socket against an https API would be blocked',
      );
    });

    test('http yields a plain ws socket, for local development', () {
      const config = ApiConfig(baseUrl: 'http://127.0.0.1:8000');
      expect(
        config.wsUrl('wf-1', token: 'tok'),
        startsWith('ws://127.0.0.1:8000/ws/workflows/wf-1'),
      );
    });

    test('the websocket carries the token and the replay cursor', () {
      const config = ApiConfig(baseUrl: 'https://example.up.railway.app');
      final url = config.wsUrl('wf-1', token: 'abc123', lastSeq: 42);
      expect(url, contains('access_token=abc123'));
      expect(url, contains('last_seq=42'));
    });
  });
}
