/// The side-navigation destinations the authenticated shell can show.
///
/// Tabs are referred to by identity rather than by index because the visible
/// set varies: a user with no organization sees a shorter bar, so a raw index
/// no longer names a fixed destination.
///
/// [chat] is the default new-chat destination (CAN-2930). It has no
/// row in the menu list; the drawer's pinned Chat button selects it. It sits
/// last in every tab list so list order keeps describing the menu rows.
///
/// [advisor] is the Orchestrator of a computer connected through Computer
/// connect (CAN-3989). It leads the drawer rows, as it does in the desktop and
/// web nav.
///
/// [account] is the Settings page (CAN-4449). It has no row either; the
/// drawer's pinned Settings cog selects it. [activity], [usage], and
/// [members] are opened from Settings instead of from a row (see
/// [settingsHomeTabs]).
enum HomeTab { activity, usage, members, advisor, account, chat }

/// Destinations opened from Settings, in the order Settings lists them. They
/// are opened only from Settings (CAN-3558).
///
/// They stay shell destinations, so their org-scoped providers, kept state,
/// and deep links work unchanged; each shows a back button to Settings.
const List<HomeTab> settingsHomeTabs = [
  HomeTab.activity,
  HomeTab.usage,
  HomeTab.members,
];

/// Tabs shown when an organization is resolved: the full app.
///
/// Drawer rows lead, then Account and the [settingsHomeTabs] it lists, the
/// same shape as [noOrganizationHomeTabs].
const List<HomeTab> organizationHomeTabs = [
  HomeTab.advisor,
  HomeTab.account,
  HomeTab.activity,
  HomeTab.usage,
  HomeTab.members,
  HomeTab.chat,
];

/// Tabs shown in Personal to an account with a Personal organization and no
/// team organization (CAN-3715).
///
/// Activity shows the viewer's own work through the Personal organization's
/// feed. Usage is left out until mobile has Personal statistics, and Members
/// leads to invitations and team creation.
const List<HomeTab> personalHomeTabs = [
  HomeTab.advisor,
  HomeTab.account,
  HomeTab.activity,
  HomeTab.members,
  HomeTab.chat,
];

/// Tabs shown to a signed-in user who belongs to no organization (CAN-2576).
///
/// Activity and Usage are dropped because their APIs are org-scoped
/// (`/api/account/organizations/{orgId}/...`) and have no personal equivalent —
/// there is nothing honest to render. Computer connect is device/user-scoped
/// and Account is account-scoped, so both work as-is. Members remains the home
/// for pending invitations and the create-an-organization CTA.
///
const List<HomeTab> noOrganizationHomeTabs = [
  HomeTab.advisor,
  HomeTab.account,
  HomeTab.members,
  HomeTab.chat,
];

/// Existing guest sessions can sign in from Settings.
const List<HomeTab> guestHomeTabs = [HomeTab.account];
