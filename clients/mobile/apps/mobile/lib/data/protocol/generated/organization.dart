// dart format off
// GENERATED FILE. Do not edit by hand.
// Maintainer-generated API bindings; verify with the adjacent public digest manifest.

/// Parses a JSON list, skipping any element this build cannot decode.
///
/// These collections are `required` on their parent, so letting one bad
/// element throw would fail the entire response. Dropping the row degrades
/// a single table instead of blanking every surface that shares the payload.
List<T> _parseList<T>(dynamic json, T Function(dynamic) parse) {
  final out = <T>[];
  for (final e in json as List<dynamic>) {
    try {
      out.add(parse(e));
    } catch (_) {
      // Unparseable row: skip it rather than failing the whole response.
      continue;
    }
  }
  return List<T>.of(out, growable: false);
}

/// Mirrors the Prisma `OrganizationRole` enum values.
enum OrganizationRole {
  owner('OWNER'),
  admin('ADMIN'),
  member('MEMBER'),
  ;

  const OrganizationRole(this.wire);

  final String wire;

  static OrganizationRole fromWire(String wire) => values.firstWhere(
        (e) => e.wire == wire,
        orElse: () => throw FormatException('Unknown OrganizationRole: $wire'),
      );
}

enum AiGatewayHarness {
  claude('claude'),
  codex('codex'),
  ;

  const AiGatewayHarness(this.wire);

  final String wire;

  static AiGatewayHarness fromWire(String wire) => values.firstWhere(
        (e) => e.wire == wire,
        orElse: () => throw FormatException('Unknown AiGatewayHarness: $wire'),
      );
}

enum AiGatewayThinkingLevel {
  off('off'),
  low('low'),
  medium('medium'),
  high('high'),
  xhigh('xhigh'),
  max('max'),
  ultra('ultra'),
  ;

  const AiGatewayThinkingLevel(this.wire);

  final String wire;

  static AiGatewayThinkingLevel fromWire(String wire) => values.firstWhere(
        (e) => e.wire == wire,
        orElse: () => throw FormatException('Unknown AiGatewayThinkingLevel: $wire'),
      );
}

/// Controls only the JSON Schema projection used for dynamically injected tools. `flat` strips composition/conditional keywords for restrictive gateway dialects; runtime argument validation is unchanged.
enum AiGatewayToolSchemaProfile {
  standard('standard'),
  flat('flat'),
  ;

  const AiGatewayToolSchemaProfile(this.wire);

  final String wire;

  static AiGatewayToolSchemaProfile fromWire(String wire) => values.firstWhere(
        (e) => e.wire == wire,
        orElse: () => throw FormatException('Unknown AiGatewayToolSchemaProfile: $wire'),
      );
}

/// What an owner lets members' outside (MCP) agents do in the organization.
enum OrganizationExternalAgentAccessWire {
  allowed('allowed'),
  readOnly('read_only'),
  notAllowed('not_allowed'),
  ;

  const OrganizationExternalAgentAccessWire(this.wire);

  final String wire;

  static OrganizationExternalAgentAccessWire fromWire(String wire) => values.firstWhere(
        (e) => e.wire == wire,
        orElse: () => throw FormatException('Unknown OrganizationExternalAgentAccessWire: $wire'),
      );
}

enum ThinkingLevel {
  off('off'),
  low('low'),
  medium('medium'),
  high('high'),
  xhigh('xhigh'),
  max('max'),
  ultra('ultra'),
  ;

  const ThinkingLevel(this.wire);

  final String wire;

  static ThinkingLevel fromWire(String wire) => values.firstWhere(
        (e) => e.wire == wire,
        orElse: () => throw FormatException('Unknown ThinkingLevel: $wire'),
      );
}

enum OrgTeamsLapseReason {
  trialEnded('trial_ended'),
  paymentFailed('payment_failed'),
  subscriptionEnded('subscription_ended'),
  ;

  const OrgTeamsLapseReason(this.wire);

  final String wire;

  static OrgTeamsLapseReason fromWire(String wire) => values.firstWhere(
        (e) => e.wire == wire,
        orElse: () => throw FormatException('Unknown OrgTeamsLapseReason: $wire'),
      );
}

/// Per-scope telemetry data-sharing policy the org sets for its members. Three-state, and every consumer must read it as such:
///
/// - `true` — REQUIRED. Forced to Organization visibility on each member's   desktop and locked on.
/// - `false` — PROHIBITED for work owned by this organization, at every share   scope. Work owned by another organization or Personal is unaffected.
/// - `null` — unset. The member's own choice, which is also the effective state   for every scope while `enforceMemberDataSharing` is false.
///
/// Read with `=== true` / `=== false`, never `!== true`: treating unset as prohibited darkens an org's dashboards, and treating it as required forces sharing nobody asked for.
class EnforcedSyncScopes {
  const EnforcedSyncScopes({this.metadata, this.plans, this.summaries, this.transcripts});

  final bool? metadata;
  final bool? plans;
  /// AI-generated worktree/session summaries, split out of `metadata`.
  final bool? summaries;
  final bool? transcripts;

  factory EnforcedSyncScopes.fromJson(Map<String, dynamic> json) => EnforcedSyncScopes(
        metadata: json['metadata'] as bool?,
        plans: json['plans'] as bool?,
        summaries: json['summaries'] as bool?,
        transcripts: json['transcripts'] as bool?,
      );
}

class OrganizationDetail {
  const OrganizationDetail({this.allowExternalContainerSharing, required this.canViewUsageStats, this.enforceMemberDataSharing, this.enforcedSync, required this.githubConnection, required this.id, this.isPersonal, this.logoUrl, required this.members, required this.name, required this.subTeams, required this.usageStatsMinRole, required this.viewerRole});

  /// Whether members may share worktrees and Cowork work with people outside the organization by email. Off unless an owner or admin turns it on. Optional for the same back-compat reason as `enforceMemberDataSharing`; the service always populates it.
  final bool? allowExternalContainerSharing;
  /// Whether the viewer's role currently clears `usageStatsMinRole`.
  final bool canViewUsageStats;
  /// Master switch for data-sharing enforcement. A sibling of `enforcedSync`, not a key inside it, so flipping the master never has to resend the scopes. Optional here for the same back-compat reason as `enforcedSync`; the service always populates it, and the settings surface reads the required field on  {@link  OrganizationConfigDetail }  instead.
  final bool? enforceMemberDataSharing;
  /// Telemetry sync scopes the org enforces on its members. Optional for back-compat; the service always populates it.
  final EnforcedSyncScopes? enforcedSync;
  /// Org-level GitHub App connection status (CAN-405).
  final OrganizationGitHubConnectionDetail githubConnection;
  final String id;
  final bool? isPersonal;
  /// Public URL of the org logo, or `null` when unset.
  final String? logoUrl;
  final List<OrganizationMember> members;
  final String name;
  final List<OrganizationSubTeam> subTeams;
  /// Minimum role required to view the usage & cost dashboard.
  final OrganizationRole usageStatsMinRole;
  /// The requesting user's role in this org.
  final OrganizationRole viewerRole;

  factory OrganizationDetail.fromJson(Map<String, dynamic> json) => OrganizationDetail(
        allowExternalContainerSharing: json['allowExternalContainerSharing'] as bool?,
        canViewUsageStats: json['canViewUsageStats'] as bool,
        enforceMemberDataSharing: json['enforceMemberDataSharing'] as bool?,
        enforcedSync: json['enforcedSync'] == null ? null : EnforcedSyncScopes.fromJson(json['enforcedSync'] as Map<String, dynamic>),
        githubConnection: OrganizationGitHubConnectionDetail.fromJson(json['githubConnection'] as Map<String, dynamic>),
        id: json['id'] as String,
        isPersonal: json['isPersonal'] as bool?,
        logoUrl: json['logoUrl'] as String?,
        members: _parseList(json['members'], (e) => OrganizationMember.fromJson(e as Map<String, dynamic>)),
        name: json['name'] as String,
        subTeams: _parseList(json['subTeams'], (e) => OrganizationSubTeam.fromJson(e as Map<String, dynamic>)),
        usageStatsMinRole: OrganizationRole.fromWire(json['usageStatsMinRole'] as String),
        viewerRole: OrganizationRole.fromWire(json['viewerRole'] as String),
      );
}

/// GitHub App connection status surfaced to the settings UI.
class OrganizationGitHubConnectionDetail {
  const OrganizationGitHubConnectionDetail({this.accountLogin, required this.connected});

  /// GitHub account login the app is installed on, when connected.
  final String? accountLogin;
  final bool connected;

  factory OrganizationGitHubConnectionDetail.fromJson(Map<String, dynamic> json) => OrganizationGitHubConnectionDetail(
        accountLogin: json['accountLogin'] as String?,
        connected: json['connected'] as bool,
      );
}

class OrganizationMember {
  const OrganizationMember({required this.email, required this.id, this.image, required this.name, required this.role, required this.subTeamIds});

  final String email;
  /// User externalId UUID.
  final String id;
  final String? image;
  final String name;
  final OrganizationRole role;
  /// externalIds of the sub-teams this member belongs to.
  final List<String> subTeamIds;

  factory OrganizationMember.fromJson(Map<String, dynamic> json) => OrganizationMember(
        email: json['email'] as String,
        id: json['id'] as String,
        image: json['image'] as String?,
        name: json['name'] as String,
        role: OrganizationRole.fromWire(json['role'] as String),
        subTeamIds: (json['subTeamIds'] as List<dynamic>).cast<String>(),
      );
}

class OrganizationSubTeam {
  const OrganizationSubTeam({required this.id, required this.memberCount, required this.name});

  /// OrganizationTeam externalId UUID.
  final String id;
  final num memberCount;
  final String name;

  factory OrganizationSubTeam.fromJson(Map<String, dynamic> json) => OrganizationSubTeam(
        id: json['id'] as String,
        memberCount: (json['memberCount'] as num?) ?? 0,
        name: json['name'] as String,
      );
}

/// Advisory share-destination access, present only when requested and resolved. Absent means unknown; share mutations remain authoritative.
class OrganizationSummarySharingAccess {
  const OrganizationSummarySharingAccess({required this.teamsEntitled});

  final bool teamsEntitled;

  factory OrganizationSummarySharingAccess.fromJson(Map<String, dynamic> json) => OrganizationSummarySharingAccess(
        teamsEntitled: json['teamsEntitled'] as bool,
      );
}

/// Dashboard panel + org switcher summary row.
class OrganizationSummary {
  const OrganizationSummary({required this.id, this.logoUrl, required this.memberCount, required this.name, required this.role, this.sharingAccess, required this.subTeamCount});

  final String id;
  /// Public URL of the org logo, or `null` when unset.
  final String? logoUrl;
  final num memberCount;
  final String name;
  final OrganizationRole role;
  /// Advisory share-destination access, present only when requested and resolved. Absent means unknown; share mutations remain authoritative.
  final OrganizationSummarySharingAccess? sharingAccess;
  final num subTeamCount;

  factory OrganizationSummary.fromJson(Map<String, dynamic> json) => OrganizationSummary(
        id: json['id'] as String,
        logoUrl: json['logoUrl'] as String?,
        memberCount: (json['memberCount'] as num?) ?? 0,
        name: json['name'] as String,
        role: OrganizationRole.fromWire(json['role'] as String),
        sharingAccess: json['sharingAccess'] == null ? null : OrganizationSummarySharingAccess.fromJson(json['sharingAccess'] as Map<String, dynamic>),
        subTeamCount: (json['subTeamCount'] as num?) ?? 0,
      );
}

class ModelGatewayModel {
  const ModelGatewayModel({required this.contextWindow, required this.gatewayId, required this.harness, required this.id, required this.label, required this.supportedThinkingLevels, required this.toolSchemaProfile});

  final num contextWindow;
  /// Exact provider/model slug sent to the customer gateway.
  final String gatewayId;
  final AiGatewayHarness harness;
  /// Canopy selection id, unique inside the org catalog.
  final String id;
  final String label;
  final List<AiGatewayThinkingLevel> supportedThinkingLevels;
  final AiGatewayToolSchemaProfile toolSchemaProfile;

  factory ModelGatewayModel.fromJson(Map<String, dynamic> json) => ModelGatewayModel(
        contextWindow: (json['contextWindow'] as num?) ?? 0,
        gatewayId: json['gatewayId'] as String,
        harness: AiGatewayHarness.fromWire(json['harness'] as String),
        id: json['id'] as String,
        label: json['label'] as String,
        supportedThinkingLevels: _parseList(json['supportedThinkingLevels'], (e) => AiGatewayThinkingLevel.fromWire(e as String)),
        toolSchemaProfile: AiGatewayToolSchemaProfile.fromWire(json['toolSchemaProfile'] as String),
      );
}

/// Org configuration surfaced to the settings UI.
class OrganizationConfigDetail {
  const OrganizationConfigDetail({required this.allowExternalContainerSharing, this.allowPublicArtifactSharing, this.applicable, required this.blockedModelIds, required this.enforceMemberDataSharing, required this.enforceMemberModelGateway, required this.enforceMemberModelPolicy, required this.enforcedSync, this.externalAgentAccess, this.modelGatewayBaseUrl, this.modelGatewayDisplayName, required this.modelGatewayEnforced, required this.modelGatewayModels, required this.modelGatewayPromptCachePassthrough, this.modelGatewayRevision, this.prohibitMemberActiveUseSignal, this.prohibitMemberErrorReports, this.prohibitMemberFeatureFlagIdentity, this.prohibitMemberProductAnalytics, this.prohibitMemberSessionReplay, required this.reviewedModelIds, required this.usageStatsMinRole});

  final bool allowExternalContainerSharing;
  /// Whether members may turn on public links for shared artifacts this organization governs (CAN-8016). Off unless an owner or admin turns it on; turning it off pauses links without clearing them. Optional for older servers; the service always populates it.
  final bool? allowPublicArtifactSharing;
  /// Whether this organization-level control applies to the target.
  final bool? applicable;
  final List<String> blockedModelIds;
  /// Master switch for data-sharing enforcement. Sibling of `enforcedSync` so the two can be updated independently; the scope columns keep their stored values while it is off, and re-enabling restores them.
  final bool enforceMemberDataSharing;
  final bool enforceMemberModelGateway;
  final bool enforceMemberModelPolicy;
  /// The org's STORED per-scope configuration, unfiltered by the org's billing plan, so the settings UI can render an uncovered scope read-only while still showing its stored value. Plan coverage is applied at projection time (see `buildOrgEnforcedSettings`), never to this read.
  final EnforcedSyncScopes enforcedSync;
  /// Owner-controlled outside-agent access, hidden by the route until rollout.
  final OrganizationExternalAgentAccessWire? externalAgentAccess;
  final String? modelGatewayBaseUrl;
  final String? modelGatewayDisplayName;
  final bool modelGatewayEnforced;
  final List<ModelGatewayModel> modelGatewayModels;
  final bool modelGatewayPromptCachePassthrough;
  final String? modelGatewayRevision;
  final bool? prohibitMemberActiveUseSignal;
  final bool? prohibitMemberErrorReports;
  final bool? prohibitMemberFeatureFlagIdentity;
  /// Member usage data: flows the organization turns off for members' desktop app while they work in this organization. Narrowing only, no plan gate, independent of `enforceMemberDataSharing`. Absent from older servers ⇒ `false`.
  final bool? prohibitMemberProductAnalytics;
  final bool? prohibitMemberSessionReplay;
  final List<String> reviewedModelIds;
  final OrganizationRole usageStatsMinRole;

  factory OrganizationConfigDetail.fromJson(Map<String, dynamic> json) => OrganizationConfigDetail(
        allowExternalContainerSharing: json['allowExternalContainerSharing'] as bool,
        allowPublicArtifactSharing: json['allowPublicArtifactSharing'] as bool?,
        applicable: json['applicable'] as bool?,
        blockedModelIds: (json['blockedModelIds'] as List<dynamic>).cast<String>(),
        enforceMemberDataSharing: json['enforceMemberDataSharing'] as bool,
        enforceMemberModelGateway: json['enforceMemberModelGateway'] as bool,
        enforceMemberModelPolicy: json['enforceMemberModelPolicy'] as bool,
        enforcedSync: EnforcedSyncScopes.fromJson(json['enforcedSync'] as Map<String, dynamic>),
        externalAgentAccess: json['externalAgentAccess'] == null ? null : OrganizationExternalAgentAccessWire.fromWire(json['externalAgentAccess'] as String),
        modelGatewayBaseUrl: json['modelGatewayBaseUrl'] as String?,
        modelGatewayDisplayName: json['modelGatewayDisplayName'] as String?,
        modelGatewayEnforced: json['modelGatewayEnforced'] as bool,
        modelGatewayModels: _parseList(json['modelGatewayModels'], (e) => ModelGatewayModel.fromJson(e as Map<String, dynamic>)),
        modelGatewayPromptCachePassthrough: json['modelGatewayPromptCachePassthrough'] as bool,
        modelGatewayRevision: json['modelGatewayRevision'] as String?,
        prohibitMemberActiveUseSignal: json['prohibitMemberActiveUseSignal'] as bool?,
        prohibitMemberErrorReports: json['prohibitMemberErrorReports'] as bool?,
        prohibitMemberFeatureFlagIdentity: json['prohibitMemberFeatureFlagIdentity'] as bool?,
        prohibitMemberProductAnalytics: json['prohibitMemberProductAnalytics'] as bool?,
        prohibitMemberSessionReplay: json['prohibitMemberSessionReplay'] as bool?,
        reviewedModelIds: (json['reviewedModelIds'] as List<dynamic>).cast<String>(),
        usageStatsMinRole: OrganizationRole.fromWire(json['usageStatsMinRole'] as String),
      );
}

/// Body of the 403 returned when an organization loses its teams capability. `code` is the reliable discriminator from permission 403s on the same route.
class OrgTeamsLapsedError {
  const OrgTeamsLapsedError({required this.code, required this.error, required this.lapseReason, this.requiredPlanName, this.trialEndedAt});

  final String code;
  final String error;
  final dynamic lapseReason;
  final String? requiredPlanName;
  final String? trialEndedAt;

  factory OrgTeamsLapsedError.fromJson(Map<String, dynamic> json) => OrgTeamsLapsedError(
        code: json['code'] as String,
        error: json['error'] as String,
        lapseReason: json['lapseReason'],
        requiredPlanName: json['requiredPlanName'] as String?,
        trialEndedAt: json['trialEndedAt'] as String?,
      );
}
