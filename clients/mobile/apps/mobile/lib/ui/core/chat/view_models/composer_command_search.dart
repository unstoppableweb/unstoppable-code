/// Identity-first slash search and the capped first view, ported from
/// `packages/ui-rich/src/plugins/commandSearch.ts`,
/// `commandSearchIdentity.ts` and `commandPresentation.ts`.
///
/// Both implementations assert `test/fixtures/slash-search-vectors.json`, so
/// a rule change updates the TypeScript contract, those vectors and this port
/// together.
///
/// Shared with Remote Control. Computer Connect also has the Rust port in
/// cc-domain::composer (search), checked against the same vectors; keep
/// both in step until cleanup C5.
library;

/// The searchable fields of one row.
typedef ComposerSearchFields = ({
  String name,
  String? displayName,
  String? description,
  String? category,
  String? namespace,
  String? memberName,
  bool available,
});

/// Command rows shown before Show all for a typed search.
const int kSlashResultLimit = 8;

/// Command rows shown per presentation group before Show all.
const int kSlashGroupLimit = 5;

const int _memberStrength = 3;
const int _qualifiedStrength = 2;
const int _pluginStrength = 1;
const int _labelStrength = 0;

final RegExp _tokenSeparator = RegExp(r'[\s:/_\-.,()]+');
final RegExp _descriptionSeparator = RegExp(r'[^\p{L}\p{N}]+', unicode: true);

const Set<String> _stopwords = {
  'a',
  'an',
  'the',
  'my',
  'me',
  'our',
  'your',
  'to',
  'for',
  'of',
  'in',
  'on',
  'with',
  'and',
  'or',
  'this',
  'that',
  'it',
  'is',
  'be',
  'do',
  'please',
};

/// Trims, lowercases and strips at most one leading `/` or `$`.
String normalizeSearchText(String? value) {
  if (value == null) return '';
  final lowered = value.trim().toLowerCase();
  final stripped = lowered.startsWith('/') || lowered.startsWith(r'$')
      ? lowered.substring(1)
      : lowered;
  return stripped.trim();
}

List<String> _tokenize(String value) => [
  for (final token in value.split(_tokenSeparator))
    if (token.isNotEmpty) token,
];

List<String> _queryTokens(String normalized) {
  final tokens = _tokenize(normalized);
  final meaningful = [
    for (final token in tokens)
      if (!_stopwords.contains(token)) token,
  ];
  return meaningful.isNotEmpty ? meaningful : tokens;
}

List<String> _descriptionWords(String? value) => value == null
    ? const []
    : [
        for (final word in value.toLowerCase().split(_descriptionSeparator))
          if (word.isNotEmpty) word,
      ];

typedef _Identity = ({String text, List<String> tokens, int strength});

String _prefixBeforeColon(String value) {
  final index = value.indexOf(':');
  return index > 0 ? value.substring(0, index) : '';
}

int _aliasStrength(String alias) =>
    alias.contains(':') ? _qualifiedStrength : _memberStrength;

List<_Identity> _identities(ComposerSearchFields fields) {
  final name = normalizeSearchText(fields.name);
  final displayName = normalizeSearchText(fields.displayName);
  var pluginName = normalizeSearchText(fields.namespace);
  if (pluginName.isEmpty) pluginName = _prefixBeforeColon(name);
  if (pluginName.isEmpty) pluginName = _prefixBeforeColon(displayName);
  var memberName = normalizeSearchText(fields.memberName);
  if (memberName.isEmpty) {
    memberName = name.contains(':')
        ? name.substring(name.indexOf(':') + 1)
        : name;
  }
  final candidates = <(String, int)>[
    (memberName, _memberStrength),
    (
      pluginName.isNotEmpty && memberName.isNotEmpty
          ? '$pluginName:$memberName'
          : '',
      _qualifiedStrength,
    ),
    (pluginName, _pluginStrength),
    (displayName, _aliasStrength(displayName)),
  ];
  final seen = <String>{};
  return [
    for (final (text, strength) in candidates)
      if (text.isNotEmpty && seen.add(text))
        (text: text, tokens: _tokenize(text), strength: strength),
  ];
}

/// Whether [a] and [b] differ by one insertion, deletion, substitution or
/// adjacent transposition.
bool isOneEditApart(String a, String b) {
  if (a == b) return false;
  final delta = a.length - b.length;
  if (delta > 1 || delta < -1) return false;
  var start = 0;
  while (start < a.length && start < b.length && a[start] == b[start]) {
    start++;
  }
  String rest(String value, int from) =>
      from >= value.length ? '' : value.substring(from);
  if (delta == 0) {
    if (rest(a, start + 1) == rest(b, start + 1)) return true;
    return start + 1 < a.length &&
        a[start] == b[start + 1] &&
        a[start + 1] == b[start] &&
        rest(a, start + 2) == rest(b, start + 2);
  }
  final longer = delta > 0 ? a : b;
  final shorter = delta > 0 ? b : a;
  return rest(longer, start + 1) == rest(shorter, start);
}

/// Shortest span holding [query] as an ordered subsequence of [text].
int? _subsequenceSpan(String text, String query) {
  if (query.isEmpty) return null;
  int? best;
  for (var start = 0; start < text.length; start++) {
    if (text[start] != query[0]) continue;
    var offset = start + 1;
    var matched = 1;
    while (matched < query.length && offset < text.length) {
      if (text[offset] == query[matched]) matched++;
      offset++;
    }
    if (matched < query.length) break;
    final span = offset - start;
    if (best == null || span < best) best = span;
  }
  return best;
}

typedef _Match = ({int tier, int strength, int exactTokens, int span});

int _compareMatches(_Match a, _Match b) {
  if (a.tier != b.tier) return a.tier - b.tier;
  if (a.strength != b.strength) return b.strength - a.strength;
  if (a.exactTokens != b.exactTokens) return b.exactTokens - a.exactTokens;
  return a.span - b.span;
}

typedef _Query = ({String full, List<String> tokens});

bool _prefixes(String token, List<String> words) =>
    words.any((word) => word.startsWith(token));

int _countExact(List<String> tokens, List<String> words) =>
    tokens.where(words.contains).length;

_Match? _matchIdentity(_Identity identity, _Query query) {
  final exactTokens = _countExact(query.tokens, identity.tokens);
  _Match match(int tier, [int span = 0]) => (
    tier: tier,
    strength: identity.strength,
    exactTokens: exactTokens,
    span: span,
  );
  if (identity.text == query.full) return match(1);
  if (identity.text.startsWith(query.full)) return match(2);
  if (query.full.length < 2) return null;
  final hasTokens = query.tokens.isNotEmpty;
  if (identity.text.contains(query.full) ||
      (hasTokens &&
          query.tokens.every((token) => _prefixes(token, identity.tokens)))) {
    return match(3);
  }
  if (hasTokens) {
    var usedEdit = false;
    final typoMatch = query.tokens.every((token) {
      if (_prefixes(token, identity.tokens)) return true;
      if (token.length < 4) return false;
      final edited = identity.tokens.any((word) => isOneEditApart(token, word));
      usedEdit = usedEdit || edited;
      return edited;
    });
    if (typoMatch && usedEdit) {
      return match(4, identity.tokens.length - query.tokens.length);
    }
  }
  final span = query.tokens.length > 1
      ? _subsequenceSpan(identity.text, query.full)
      : null;
  return span == null ? null : match(6, span);
}

_Match? _matchRow(ComposerSearchFields fields, _Query query) {
  final identities = _identities(fields);
  final candidates = <_Match?>[
    for (final identity in identities) _matchIdentity(identity, query),
  ];
  if (query.full.length >= 2 && query.tokens.isNotEmpty) {
    final description = _descriptionWords(fields.description);
    if (query.tokens.every(description.contains)) {
      candidates.add((
        tier: 5,
        strength: _labelStrength,
        exactTokens: _countExact(query.tokens, description),
        span: 0,
      ));
    }
  }
  _Match? best;
  for (final candidate in candidates) {
    if (candidate != null &&
        (best == null || _compareMatches(candidate, best) < 0)) {
      best = candidate;
    }
  }
  return best;
}

/// Identity-first ranking across [items]. An empty query keeps every item in
/// order. Five primary tiers match identity exact, prefix, substring/tokens,
/// one-edit typos and whole description words. Typos prefer fewer unmatched
/// identity tokens before enablement. Single-word description matches are
/// fallback only. Multi-token identity subsequences are a last resort only
/// when all five primary tiers miss (the `ecom-debbuger` golden).
List<T> searchComposerItems<T>(
  List<T> items,
  String query,
  ComposerSearchFields Function(T item) fields,
) {
  final full = normalizeSearchText(query);
  if (full.isEmpty) return List.of(items);
  final prepared = (full: full, tokens: _queryTokens(full));
  final ranked = <({T item, int index, _Match match, bool available})>[];
  for (final (index, item) in items.indexed) {
    final f = fields(item);
    final match = _matchRow(f, prepared);
    if (match != null) {
      ranked.add((
        item: item,
        index: index,
        match: match,
        available: f.available,
      ));
    }
  }
  ranked.sort((a, b) {
    final byMatch = _compareMatches(a.match, b.match);
    if (byMatch != 0) return byMatch;
    if (a.available != b.available) return a.available ? 1 : -1;
    return a.index - b.index;
  });
  final hasIdentity = ranked.any((row) => row.match.tier <= 4);
  final hasDescription = ranked.any((row) => row.match.tier == 5);
  return [
    for (final row in ranked)
      if (hasIdentity
          ? row.match.tier <= 4 ||
                (row.match.tier == 5 && prepared.tokens.length > 1)
          : hasDescription
          ? row.match.tier == 5
          : true)
        row.item,
  ];
}

/// Admits at most [total] rows and at most [perGroup] rows per group key,
/// counted across repeated runs of a group, in ranked order. Later groups
/// fill slots skipped by a full group.
({List<T> visible, int hiddenCount}) limitSlashResults<T>(
  List<T> rows,
  String Function(T row) groupKey, {
  int? total,
  int? perGroup,
}) {
  final totalLimit = total != null && total > 0 ? total : kSlashResultLimit;
  final groupLimit = perGroup != null && perGroup > 0
      ? perGroup
      : kSlashGroupLimit;
  final counts = <String, int>{};
  final visible = <T>[];
  for (final row in rows) {
    if (visible.length >= totalLimit) break;
    final key = groupKey(row);
    final count = counts[key] ?? 0;
    if (count >= groupLimit) continue;
    counts[key] = count + 1;
    visible.add(row);
  }
  return (visible: visible, hiddenCount: rows.length - visible.length);
}

/// Splits rows into contiguous same-group runs without reordering them.
List<({String key, int occurrence, List<T> rows})> groupContiguousRuns<T>(
  List<T> rows,
  String Function(T row) groupKey,
) {
  final runs = <({String key, int occurrence, List<T> rows})>[];
  final occurrences = <String, int>{};
  for (final row in rows) {
    final key = groupKey(row);
    if (runs.isNotEmpty && runs.last.key == key) {
      runs.last.rows.add(row);
      continue;
    }
    final occurrence = occurrences[key] ?? 0;
    occurrences[key] = occurrence + 1;
    runs.add((key: key, occurrence: occurrence, rows: [row]));
  }
  return runs;
}
