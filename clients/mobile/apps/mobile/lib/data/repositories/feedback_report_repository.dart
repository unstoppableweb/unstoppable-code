import 'dart:async';

import 'package:mobile/data/models/feedback_report.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/feedback_report_api_service.dart';

/// Contract for filing an app-wide feedback report ("Report a bug" / "Share
/// an idea"). Unlike turn feedback, these are not tied to a chat turn and
/// have no offline outbox — a failed submit simply surfaces to the caller so
/// the sheet can keep the typed text and let the user retry.
abstract interface class FeedbackReportRepository {
  Future<FeedbackReportResult> submit({
    required FeedbackReportType type,
    required String description,
    required Map<String, dynamic> context,
  });
}

/// Live [FeedbackReportRepository] backed by [FeedbackReportApiService].
final class HttpFeedbackReportRepository implements FeedbackReportRepository {
  const HttpFeedbackReportRepository({
    required this.service,
    this.requestTimeout = const Duration(seconds: 30),
  });

  final FeedbackReportApiService service;

  /// How long ONE report submission may stay open before it is abandoned.
  ///
  /// `ApiClient` sets no timeout of its own and `dart:io`'s `HttpClient` has no
  /// default in-flight request timeout, so a half-open socket (a cellular/Wi-Fi
  /// handoff, not an exotic failure) leaves the request open until the OS tears
  /// the connection down.
  ///
  /// What expiry costs here is the whole point of bounding it. This path has no
  /// outbox: the sheet is the only place the user's typed report exists. An
  /// unbounded submit leaves that sheet spinning with Cancel, the text field,
  /// and Submit all disabled and no error — the only exit is the modal barrier,
  /// which disposes the controller and destroys the report with nothing to
  /// retry. A BOUNDED one fails like any other failed submit: the sheet stays
  /// open, the typed text is intact, and the error is retryable. That is the
  /// difference between a failed submit (which this feature's acceptance
  /// criteria allow for) and a hung one (which they do not).
  ///
  /// Expiry needs no new copy. `presentableErrorMessage` returns null for a
  /// [TimeoutException] — it is not an `ApiException` — so the sheet falls
  /// through to its existing generic retryable sentence, exactly as it does for
  /// a 5xx.
  ///
  /// The 30-second default is CHOSEN, not measured: it is a liveness bound on
  /// a stuck connection, not a latency budget.
  ///
  /// It does not cancel the request server-side, so an expired submit the
  /// server did accept files a DUPLICATE report if the user retries. Do not
  /// read that as a theoretical edge. `POST /api/v1/feedback/reports` creates
  /// a Linear issue through `@linear/sdk`, and `apps/web/src/lib/feedback/
  /// linear-client.ts` passes no `AbortSignal` and sets no timeout on the
  /// GraphQL call or on its one raw attachment `fetch` — so whenever Linear is
  /// slow, "the client gave up while the server went on to succeed" is the
  /// ORDINARY outcome, not an unlikely one, and the retry the sheet invites is
  /// what produces the second issue. Bounding the client is still the right
  /// trade against silently eating the report entirely, but the duplicate is
  /// the expected cost, not a remote one. A server-side
  /// `(userId, clientReportId)` upsert key is the actual fix and is tracked as
  /// a follow-up.
  final Duration requestTimeout;

  @override
  Future<FeedbackReportResult> submit({
    required FeedbackReportType type,
    required String description,
    required Map<String, dynamic> context,
  }) => service
      .submit(type: type, description: description, context: context)
      .timeout(requestTimeout);
}

/// In-memory [FeedbackReportRepository] used in mock mode and widget tests.
final class MockFeedbackReportRepository implements FeedbackReportRepository {
  MockFeedbackReportRepository({
    this.latency = const Duration(milliseconds: 300),
    this.failSubmits = false,
  });

  final Duration latency;

  /// When true every submit throws a 503 [ApiException], exercising the
  /// sheet's failure path (keeps the sheet open with the typed text intact)
  /// without a network stub. Mutable (not `final`) so a widget test can flip
  /// it between submits to exercise "retry after failure" without swapping
  /// the repository instance the sheet already captured.
  bool failSubmits;

  @override
  Future<FeedbackReportResult> submit({
    required FeedbackReportType type,
    required String description,
    required Map<String, dynamic> context,
  }) async {
    await Future<void>.delayed(latency);
    if (failSubmits) {
      throw const ApiException(statusCode: 503, body: '{}');
    }
    return const FeedbackReportResult(
      issueIdentifier: 'CAN-0000',
      issueUrl: 'https://example.invalid',
    );
  }
}

/// Live-config [FeedbackReportRepository] that re-checks [isConfigured] on
/// every call instead of freezing the http/mock choice at construction.
///
/// [FeedbackReportRepository] is provided in `buildRootProviders()` (see
/// `main.dart`), which sits ABOVE the demo-mode/API-environment reactive
/// boundary in `App.build()` — it is therefore built only once for the app's
/// lifetime. Returning a plain [HttpFeedbackReportRepository] or
/// [MockFeedbackReportRepository] there would freeze whichever repository
/// `AppConfig.hasAuthApiConfig` returned AT THAT INSTANT: if the app boots
/// outside demo mode, a later demo-mode toggle would still route "Send
/// feedback" submissions to the real backend.
final class LiveConfigFeedbackReportRepository
    implements FeedbackReportRepository {
  LiveConfigFeedbackReportRepository({
    required this.isConfigured,
    required this.http,
    required this.mock,
  });

  /// Re-checked on every call. `true` routes to [http]; `false` routes to
  /// [mock].
  final bool Function() isConfigured;

  final FeedbackReportRepository http;
  final FeedbackReportRepository mock;

  @override
  Future<FeedbackReportResult> submit({
    required FeedbackReportType type,
    required String description,
    required Map<String, dynamic> context,
  }) => (isConfigured() ? http : mock).submit(
    type: type,
    description: description,
    context: context,
  );
}
