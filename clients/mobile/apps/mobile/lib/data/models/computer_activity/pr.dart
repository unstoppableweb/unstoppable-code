import 'package:mobile/data/models/computer_activity/pr_status.dart';

enum RemotePrAction {
  refresh('get_actions'),
  create('create_auto'),
  merge('merge');

  const RemotePrAction(this.wireValue);
  final String wireValue;
}

/// Internal result marker used when a refresh completed after newer state.
///
/// PR action results otherwise mirror the desktop payload, so keeping this as
/// a reserved key avoids widening the runner contract solely for refresh
/// reconciliation.
const remotePrActionDiscardedKey = '_canopyDiscarded';

const remotePrActionDiscardedResult = <String, dynamic>{
  remotePrActionDiscardedKey: true,
};

bool isRemotePrActionResultDiscarded(Map<String, dynamic> result) =>
    result[remotePrActionDiscardedKey] == true;

typedef RemotePrActionRunner =
    Future<Map<String, dynamic>> Function(
      RemotePrAction action, {
      String? repoId,
      RemotePrActionIdentity? identity,
      bool confirmUnresolvedComments,
    });

/// Immutable repository identity shown when a PR action is selected.
class RemotePrActionIdentity {
  const RemotePrActionIdentity({
    required this.baseBranch,
    required this.headBranch,
    this.prNumber,
  });

  final String baseBranch;
  final String headBranch;
  final int? prNumber;
}

/// Eligibility is computed by the desktop, never inferred from CI colors.
class RemotePrRepo {
  const RemotePrRepo({
    required this.repoId,
    required this.repoName,
    this.pr,
    this.baseBranch,
    this.headBranch,
    this.published,
    this.canCreate = false,
    this.canMerge = false,
    this.mergeWarning = false,
    this.createBlockedReason,
    this.mergeBlockedReason,
  });
  final String repoId;
  final String repoName;
  final RemoteWorktreePr? pr;

  /// Branch a new PR would target. Absent on hosts that cannot resolve it.
  final String? baseBranch;
  final String? headBranch;
  final bool? published;
  final bool canCreate;
  final bool canMerge;
  final bool mergeWarning;

  /// Wire `RemoteControlPrCreateBlockedReason` / `RemoteControlPrMergeBlockedReason`. Kept as
  /// strings so an unknown reason from a newer desktop degrades to silence
  /// rather than a parse failure.
  final String? createBlockedReason;
  final String? mergeBlockedReason;

  /// Action eligibility is a host read; displayed PR status comes from the session.
  RemotePrRepo withPr(RemoteWorktreePr? status) => RemotePrRepo(
    repoId: repoId,
    repoName: repoName,
    pr: status,
    baseBranch: baseBranch,
    headBranch: headBranch,
    published: published,
    canCreate: canCreate,
    canMerge: canMerge,
    mergeWarning: mergeWarning,
    createBlockedReason: createBlockedReason,
    mergeBlockedReason: mergeBlockedReason,
  );

  factory RemotePrRepo.fromJson(Map<String, dynamic> json) => RemotePrRepo(
    repoId: json['repoId'] as String? ?? '',
    repoName: json['repoName'] as String? ?? 'Repository',
    pr: json['status'] is Map<String, dynamic>
        ? RemoteWorktreePr.fromRemoteControl(
            json['status'] as Map<String, dynamic>,
            repoId: json['repoId'] as String?,
          )
        : null,
    baseBranch: json['baseBranch'] is String
        ? json['baseBranch'] as String
        : null,
    headBranch: json['headBranch'] is String
        ? json['headBranch'] as String
        : null,
    published: json['published'] as bool?,
    canCreate: json['canCreate'] == true,
    canMerge: json['canMerge'] == true,
    mergeWarning: json['mergeWarning'] == true,
    createBlockedReason: json['createBlockedReason'] is String
        ? json['createBlockedReason'] as String
        : null,
    mergeBlockedReason: json['mergeBlockedReason'] is String
        ? json['mergeBlockedReason'] as String
        : null,
  );
}
