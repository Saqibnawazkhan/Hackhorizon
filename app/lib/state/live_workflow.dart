/// Live execution streaming for screens 4a and 4b.
///
/// Connects to the backend WebSocket, replays anything missed via `last_seq`,
/// and folds each event into a local view of the workflow so the stepper
/// updates without re-fetching.
///
/// DEGRADES GRACEFULLY. If the socket cannot connect or drops, the controller
/// falls back to polling `GET /workflows/{id}` -- every WS event has a REST
/// equivalent, so the screen stays correct either way. That matters on a
/// phone, where a backgrounded app loses its socket routinely.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../api/models.dart';
import 'providers.dart';

enum LiveConnection { connecting, live, polling, closed }

class LiveWorkflowState {
  const LiveWorkflowState({
    this.detail,
    this.connection = LiveConnection.connecting,
    this.lastSeq = 0,
    this.error,
    this.events = const [],
  });

  final WorkflowDetail? detail;
  final LiveConnection connection;
  final int lastSeq;
  final String? error;

  /// Human-readable log of what arrived, newest last.
  final List<String> events;

  LiveWorkflowState copyWith({
    WorkflowDetail? detail,
    LiveConnection? connection,
    int? lastSeq,
    String? error,
    List<String>? events,
  }) =>
      LiveWorkflowState(
        detail: detail ?? this.detail,
        connection: connection ?? this.connection,
        lastSeq: lastSeq ?? this.lastSeq,
        error: error,
        events: events ?? this.events,
      );
}

class LiveWorkflowController extends StateNotifier<LiveWorkflowState> {
  LiveWorkflowController(this._ref, this._workflowId)
      : super(const LiveWorkflowState()) {
    _start();
  }

  final Ref _ref;
  final String _workflowId;

  WebSocketChannel? _channel;
  StreamSubscription? _sub;
  Timer? _pollTimer;
  Timer? _reconnectTimer;
  int _reconnectAttempts = 0;
  bool _disposed = false;

  static const _maxReconnectAttempts = 4;
  static const _pollInterval = Duration(seconds: 3);

  Future<void> _start() async {
    // Load the current state first, so the screen renders immediately rather
    // than waiting on a socket handshake.
    await _refresh();
    if (_disposed) return;
    await _connect();
  }

  Future<void> _refresh() async {
    try {
      final detail = await _ref.read(apiClientProvider).getWorkflow(_workflowId);
      if (_disposed) return;
      state = state.copyWith(detail: detail);

      // Stop polling once the run reaches a terminal state.
      if (detail.status.isTerminal ||
          detail.status == WorkflowStatus.awaitingApproval) {
        _pollTimer?.cancel();
      }
    } catch (e) {
      if (!_disposed) state = state.copyWith(error: e.toString());
    }
  }

  Future<void> _connect() async {
    final token = await _ref.read(authProvider.notifier).accessToken();
    if (token == null || _disposed) {
      _startPolling();
      return;
    }

    try {
      // Always replay in full rather than from `lastSeq`.
      //
      // The server writes the durable event rows in the background now, so a
      // frame delivered live has no cursor on it yet -- only replayed frames
      // carry one. Resuming from the last cursor we saw would therefore
      // re-send everything that arrived live since, and the feed below
      // appends, so each reconnect would duplicate lines.
      //
      // Replaying from zero and rebuilding the feed is exact. A workflow is
      // about twenty events and the query is off the execution path, so the
      // cost of the full catch-up is not worth the bookkeeping to avoid.
      final url = _ref.read(apiConfigProvider).wsUrl(
            _workflowId,
            token: token,
            lastSeq: 0,
          );
      _channel = WebSocketChannel.connect(Uri.parse(url));
      await _channel!.ready;
      if (_disposed) return;

      _reconnectAttempts = 0;
      _pollTimer?.cancel();
      state = state.copyWith(
        connection: LiveConnection.live,
        error: null,
        lastSeq: 0,
        events: const [],
      );

      _sub = _channel!.stream.listen(
        _onFrame,
        onError: (_) => _onDisconnected(),
        onDone: _onDisconnected,
        cancelOnError: true,
      );
    } catch (_) {
      // A socket is an optimisation, not a requirement.
      _startPolling();
    }
  }

  void _onFrame(dynamic raw) {
    if (_disposed) return;
    Map<String, dynamic> frame;
    try {
      frame = jsonDecode(raw as String) as Map<String, dynamic>;
    } catch (_) {
      return;
    }

    final type = frame['type'] as String? ?? '';
    final seq = (frame['seq'] as num?)?.toInt() ?? state.lastSeq;
    final payload = (frame['payload'] as Map?)?.cast<String, dynamic>() ?? {};

    if (type == 'heartbeat') return;

    final label = switch (type) {
      'step.started' => 'Started ${payload['title'] ?? payload['name']}',
      'step.completed' => 'Completed ${payload['name']}',
      'step.failed' => 'Failed ${payload['name']}: ${payload['error']}',
      'step.retrying' =>
        'Retrying ${payload['name']} '
            '(${payload['attempt']}/${payload['max_attempts']})',
      'tool.called' => 'Tool ${payload['tool_name']} (${payload['status']})',
      'comparison.ready' => 'Comparison ready',
      'validation.result' =>
        'Validation ${payload['passed'] == true ? 'passed' : 'failed'}',
      'approval.required' => 'Awaiting human approval',
      'workflow.completed' => 'Workflow ${payload['status']}',
      'workflow.escalated' => 'Escalated: ${payload['reason']}',
      _ => type,
    };

    state = state.copyWith(
      lastSeq: seq > state.lastSeq ? seq : state.lastSeq,
      events: [...state.events, label],
    );

    // The frames carry deltas; the authoritative shape comes from REST. One
    // refresh per event keeps the stepper honest without hand-merging state.
    _refresh();
  }

  void _onDisconnected() {
    if (_disposed) return;
    _sub?.cancel();
    _channel = null;

    if (_reconnectAttempts < _maxReconnectAttempts) {
      _reconnectAttempts++;
      // Back off and reconnect; the replay on connect is what recovers
      // anything that happened while the socket was down.
      _reconnectTimer = Timer(
        Duration(milliseconds: 400 * (1 << _reconnectAttempts)),
        _connect,
      );
      state = state.copyWith(connection: LiveConnection.connecting);
    } else {
      _startPolling();
    }
  }

  void _startPolling() {
    if (_disposed) return;
    state = state.copyWith(connection: LiveConnection.polling);
    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(_pollInterval, (_) => _refresh());
  }

  /// Manual retry from the UI.
  Future<void> reconnect() async {
    _reconnectAttempts = 0;
    await _connect();
  }

  @override
  void dispose() {
    _disposed = true;
    _sub?.cancel();
    _pollTimer?.cancel();
    _reconnectTimer?.cancel();
    _channel?.sink.close();
    super.dispose();
  }
}

final liveWorkflowProvider = StateNotifierProvider.autoDispose
    .family<LiveWorkflowController, LiveWorkflowState, String>(
  (ref, workflowId) => LiveWorkflowController(ref, workflowId),
);
