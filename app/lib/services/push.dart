/// Push notifications and deep links.
///
/// The agent pauses at the human gate and cannot continue until a person
/// decides. That person is usually not looking at the app, which is the whole
/// reason push exists here: `route_approval` sends one, tapping it opens that
/// approval directly.
///
/// FIREBASE IS OPTIONAL AT RUNTIME. Without `google-services.json` the
/// initialise call throws, and a hackathon build that white-screens because a
/// config file is missing is worse than one that runs without push. Every
/// failure is caught, recorded in [PushService.status], and surfaced on the
/// settings row rather than swallowed — an unexplained silence is how push
/// bugs survive to production.
///
/// Deep-link format, matching `agent/orchestrator/nodes.py`:
///
///     agentflow://approvals/<approval id>
///     agentflow://workflows/<workflow id>
library;

import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../api/api_client.dart';

/// Where a notification tap should take the user.
class DeepLink {
  const DeepLink({required this.kind, required this.id});

  /// `approvals` or `workflows`.
  final String kind;
  final String id;

  bool get isApproval => kind == 'approvals';
  bool get isWorkflow => kind == 'workflows';

  /// A vendor being told an order was raised against their catalog.
  bool get isPurchaseOrder => kind == 'purchase-orders';

  /// Parses `agentflow://approvals/<id>`. Returns null for anything else, so
  /// a malformed link is ignored rather than navigating somewhere wrong.
  static DeepLink? parse(String? raw) {
    if (raw == null || raw.isEmpty) return null;
    final uri = Uri.tryParse(raw);
    if (uri == null || uri.scheme != 'agentflow') return null;

    // agentflow://approvals/<id> parses host=approvals, path=/<id>.
    final kind = uri.host.isNotEmpty
        ? uri.host
        : (uri.pathSegments.isNotEmpty ? uri.pathSegments.first : '');
    final segments = uri.host.isNotEmpty
        ? uri.pathSegments
        : uri.pathSegments.skip(1).toList();
    if (segments.isEmpty) return null;
    const known = {'approvals', 'workflows', 'purchase-orders'};
    if (!known.contains(kind)) return null;
    return DeepLink(kind: kind, id: segments.first);
  }

  /// The data payload carries the ids separately, which survives a link the
  /// sender never set.
  static DeepLink? fromData(Map<String, dynamic> data) {
    final explicit = parse(data['deep_link'] as String?);
    if (explicit != null) return explicit;

    final approval = '${data['approval_id'] ?? ''}';
    if (approval.isNotEmpty) {
      return DeepLink(kind: 'approvals', id: approval);
    }
    final workflow = '${data['workflow_id'] ?? ''}';
    if (workflow.isNotEmpty) {
      return DeepLink(kind: 'workflows', id: workflow);
    }
    return null;
  }
}

enum PushStatus {
  /// Not attempted yet.
  idle,

  /// Firebase is up, permission granted, token registered.
  ready,

  /// The user declined the OS permission prompt.
  denied,

  /// No Firebase configuration in this build.
  unconfigured,

  /// Firebase is up but something else failed — see [PushService.detail].
  failed,
}

/// Entry point for a background message.
///
/// Must be a top-level function: the OS starts a fresh isolate for it, so it
/// cannot close over anything. Nothing to do here beyond existing — Android
/// renders the notification itself when the app is not running.
@pragma('vm:entry-point')
Future<void> firebaseBackgroundHandler(RemoteMessage message) async {}

class PushService {
  PushService._();

  static final PushService instance = PushService._();

  final _linkController = StreamController<DeepLink>.broadcast();

  /// Taps, whether the app was running or launched by the notification.
  Stream<DeepLink> get onDeepLink => _linkController.stream;

  PushStatus status = PushStatus.idle;
  String? detail;
  String? token;

  FlutterLocalNotificationsPlugin? _local;
  bool _started = false;

  static const _channel = AndroidNotificationChannel(
    'agentflow_approvals',
    'Approvals and escalations',
    description: 'Runs that have paused and need a person to decide.',
    importance: Importance.high,
  );

  /// Safe to call more than once; only the first call does anything.
  Future<void> start(ApiClient client) async {
    if (_started) return;
    _started = true;

    try {
      await Firebase.initializeApp();
    } catch (e) {
      // Overwhelmingly this is a missing google-services.json. The app is
      // fully usable without push; it just cannot be told about a pause.
      status = PushStatus.unconfigured;
      detail = 'Firebase is not configured in this build.';
      debugPrint('push: firebase unavailable — $e');
      return;
    }

    try {
      final messaging = FirebaseMessaging.instance;
      final settings = await messaging.requestPermission();
      if (settings.authorizationStatus == AuthorizationStatus.denied) {
        status = PushStatus.denied;
        detail = 'Notifications are turned off for AgentFlow.';
        return;
      }

      await _initLocalNotifications();
      FirebaseMessaging.onBackgroundMessage(firebaseBackgroundHandler);

      // Foreground messages do not raise a notification on their own.
      FirebaseMessaging.onMessage.listen(_showForeground);

      // Tapped while the app was backgrounded.
      FirebaseMessaging.onMessageOpenedApp.listen((m) {
        final link = DeepLink.fromData(m.data);
        if (link != null) _linkController.add(link);
      });

      // Tapped while the app was not running at all. This is checked once,
      // after the first frame, so the navigator exists to receive it.
      final initial = await messaging.getInitialMessage();
      if (initial != null) {
        final link = DeepLink.fromData(initial.data);
        if (link != null) _linkController.add(link);
      }

      await _syncToken(client, messaging);
      messaging.onTokenRefresh.listen((t) => _register(client, t));

      status = PushStatus.ready;
      detail = null;
    } catch (e) {
      status = PushStatus.failed;
      detail = '$e';
      debugPrint('push: setup failed — $e');
    }
  }

  Future<void> _initLocalNotifications() async {
    final plugin = FlutterLocalNotificationsPlugin();
    await plugin.initialize(
      const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      ),
      onDidReceiveNotificationResponse: (response) {
        final link = DeepLink.parse(response.payload);
        if (link != null) _linkController.add(link);
      },
    );
    await plugin
        .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>()
        ?.createNotificationChannel(_channel);
    _local = plugin;
  }

  Future<void> _showForeground(RemoteMessage message) async {
    final plugin = _local;
    final notification = message.notification;
    if (plugin == null || notification == null) return;

    await plugin.show(
      notification.hashCode,
      notification.title,
      notification.body,
      NotificationDetails(
        android: AndroidNotificationDetails(
          _channel.id,
          _channel.name,
          channelDescription: _channel.description,
          importance: Importance.high,
          priority: Priority.high,
        ),
      ),
      payload: '${message.data['deep_link'] ?? ''}',
    );
  }

  Future<void> _syncToken(ApiClient client, FirebaseMessaging messaging) async {
    final value = await messaging.getToken();
    if (value == null) return;
    token = value;
    await _register(client, value);
  }

  Future<void> _register(ApiClient client, String value) async {
    token = value;
    try {
      await client.registerDevice(token: value);
    } on ApiException catch (e) {
      // Not fatal. The device simply does not receive push this session.
      debugPrint('push: token registration failed — ${e.message}');
    }
  }

  /// Called on sign-out, so the next person to use this phone does not get
  /// the previous user's approvals.
  ///
  /// Deliberately NOT awaited by its caller. Signing out is a local act and
  /// must not be hostage to a server round trip; this is started while the
  /// session is still valid and left to finish on its own.
  ///
  /// It is also no longer load-bearing. The backend drops any registration of
  /// this token belonging to another user the moment the next person
  /// registers, so a delete that never lands costs one rejected send, not a
  /// notification delivered to the wrong person.
  void forget(ApiClient client) {
    final value = token;
    token = null;
    _started = false; // so the next signed-in user re-registers their own
    if (value == null) return;
    unawaited(
      client.unregisterDevice(token: value).catchError(
        (Object e) => debugPrint('push: token removal skipped — $e'),
      ),
    );
  }

  /// One line for the settings row, so the state is never a mystery.
  String get statusLine => switch (status) {
        PushStatus.ready => 'On — you will be told when a run needs you',
        PushStatus.denied => 'Off — enable notifications in system settings',
        PushStatus.unconfigured =>
          'Unavailable — this build has no Firebase configuration',
        PushStatus.failed => 'Unavailable — ${detail ?? 'setup failed'}',
        PushStatus.idle => 'Starting…',
      };

  void dispose() => _linkController.close();
}
