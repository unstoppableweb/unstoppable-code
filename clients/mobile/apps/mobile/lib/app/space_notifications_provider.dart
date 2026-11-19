import 'package:provider/provider.dart';
import 'package:provider/single_child_widget.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/repositories/space_notifications_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/space_notifications_api_service.dart';
import 'package:mobile/ui/features/device_link/space_notifications/space_notifications_view_model.dart';

/// Provides the per-space notification choices offered from Computer connect
/// rows. Mounted in the account-keyed Computer connect scope, so another
/// account gets a fresh view model and none of this one's choices.
///
/// The choices are the account's own server setting
/// (`/api/v1/notification-spaces/{spaceId}`), read with the sign-in session as
/// relay access is; without API config the mock serves them.
SingleChildWidget spaceNotificationsProvider({
  required String? Function() sessionToken,
  required String? Function() twoFactorProof,
}) => ChangeNotifierProvider<SpaceNotificationsViewModel>(
  create: (_) => SpaceNotificationsViewModel(
    repository: AppConfig.hasAuthApiConfig
        ? HttpSpaceNotificationsRepository(
            service: SpaceNotificationsApiService(
              apiClient: ApiClient.withBaseUrlProvider(
                baseUrlProvider: () => AppConfig.apiBaseUrl,
                tokenProvider: sessionToken,
                twoFactorProofProvider: twoFactorProof,
              ),
            ),
          )
        : MockSpaceNotificationsRepository(),
  ),
);
