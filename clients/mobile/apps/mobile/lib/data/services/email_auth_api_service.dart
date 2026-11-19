import 'dart:convert';

import 'package:mobile/data/services/api_client.dart';

sealed class EmailPasswordProof {
  const EmailPasswordProof();
}

final class EmailExchangeCode extends EmailPasswordProof {
  const EmailExchangeCode(this.code);
  final String code;
}

final class EmailFactorChallenge extends EmailPasswordProof {
  const EmailFactorChallenge(this.challenge);
  final String challenge;
}

final class EmailVerificationRequired extends EmailPasswordProof {
  const EmailVerificationRequired();
}

/// Only locally authored copy crosses into the authentication UI.
final class EmailAuthException implements Exception {
  const EmailAuthException(this.code, {this.retryAfterSeconds});
  final String code;
  final int? retryAfterSeconds;

  bool get unavailable => code == 'EMAIL_AUTH_UNAVAILABLE';
  bool get needsNewCode => code == 'OTP_EXPIRED' || code == 'TOO_MANY_ATTEMPTS';

  String get message => switch (code) {
    'INVALID_CREDENTIALS' || 'INVALID_EMAIL_OR_PASSWORD' =>
      "That email and password don't match. Try again or reset your password.",
    'INVALID_OTP' => "That code isn't right. Check it and try again.",
    'OTP_EXPIRED' => 'That code has expired. Request a new one.',
    'TOO_MANY_ATTEMPTS' => 'Too many incorrect codes. Request a new one.',
    'RATE_LIMITED' =>
      retryAfterSeconds == null
          ? 'Too many attempts. Wait a few minutes and try again.'
          : 'Too many attempts. Try again in $retryAfterSeconds seconds.',
    'PASSWORD_TOO_SHORT' => 'Use at least 12 characters.',
    'PASSWORD_TOO_LONG' => 'Use 128 characters or fewer.',
    'PASSWORD_COMPROMISED' =>
      'This is a commonly used password. Attackers try these first, so choose a different one.',
    'EMAIL_AUTH_UNAVAILABLE' =>
      "Email sign-in isn't available right now. Choose another sign-in method.",
    _ => 'Something went wrong. Try again.',
  };
}

/// Native email entry uses the guarded mobile password exchange. Ownership and
/// recovery use the same session-free Better Auth endpoints as the browser.
final class EmailAuthApiService {
  const EmailAuthApiService({required this.apiClient});
  final ApiClient apiClient;

  Future<bool> available() async {
    try {
      final body = await apiClient
          .getJson('/api/mobile/email-auth', retryTransient: false)
          .timeout(const Duration(seconds: 10));
      return body['enabled'] == true;
    } catch (_) {
      // Includes an older server's 404. Social signin remains usable.
      return false;
    }
  }

  Future<EmailPasswordProof> signIn({
    required String email,
    required String password,
    required String codeChallenge,
  }) async {
    final body = await _post('/api/mobile/email-auth/sign-in', {
      'email': email,
      'password': password,
      'code_challenge': codeChallenge,
      'code_challenge_method': 'S256',
    });
    if (body case {'code': final String code} when code.isNotEmpty) {
      return EmailExchangeCode(code);
    }
    if (body case {
      'two_factor_required': true,
      'challenge': final String challenge,
    } when challenge.isNotEmpty) {
      return EmailFactorChallenge(challenge);
    }
    if (body['verification_required'] == true) {
      return const EmailVerificationRequired();
    }
    throw const EmailAuthException('AUTH_UNAVAILABLE');
  }

  Future<void> signUp(String email, String password) async {
    await _post('/api/auth/sign-up/email', {
      'email': email,
      'password': password,
      'name': '',
    });
  }

  Future<void> verify(String email, String code) async {
    await _post('/api/auth/email-otp/verify-email', {
      'email': email,
      'otp': code,
    });
  }

  Future<void> forgot(String email) async {
    await _post('/api/auth/email-otp/request-password-reset', {'email': email});
  }

  Future<void> reset(String email, String code, String password) async {
    await _post('/api/auth/email-otp/reset-password', {
      'email': email,
      'otp': code,
      'password': password,
    });
  }

  Future<Map<String, dynamic>> _post(String path, Object body) async {
    try {
      return await apiClient
          .postJson(path, body: body)
          .timeout(const Duration(seconds: 30));
    } on ApiException catch (error) {
      String? code;
      try {
        final json = jsonDecode(error.body);
        if (json is Map<String, dynamic>) {
          final value = json['code'] ?? json['error'];
          if (value is String) code = value;
        }
      } catch (_) {
        /* Non-JSON errors use local fallback copy. */
      }
      final rawRetry = error.headers['retry-after'];
      final seconds = rawRetry == null ? null : int.tryParse(rawRetry);
      final date = rawRetry == null ? null : DateTime.tryParse(rawRetry);
      final dateSeconds = date?.difference(DateTime.now()).inSeconds;
      final retry = seconds ?? dateSeconds;
      throw EmailAuthException(
        error.statusCode == 404
            ? 'EMAIL_AUTH_UNAVAILABLE'
            : error.statusCode == 429
            ? 'RATE_LIMITED'
            : code ?? 'AUTH_UNAVAILABLE',
        retryAfterSeconds: retry != null && retry > 0 ? retry : null,
      );
    } on EmailAuthException {
      rethrow;
    } catch (_) {
      throw const EmailAuthException('AUTH_UNAVAILABLE');
    }
  }
}
