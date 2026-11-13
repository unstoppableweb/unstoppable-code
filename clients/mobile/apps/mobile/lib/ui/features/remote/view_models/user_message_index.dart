/// Membership at send time without copying all historical user-message IDs.
/// Additions carry a generation, so an older capture cannot see newer IDs.
/// Removals/reordering replace the map; existing captures keep their old view.
class UserMessageIndex {
  Map<String, int> _ids = {};
  int _generation = 0;

  void add(String id) => _ids.putIfAbsent(id, () => ++_generation);

  void replace(Iterable<String> ids) {
    _ids = {for (final id in ids) id: 0};
    _generation = 0;
  }

  bool Function(String) capture() {
    final ids = _ids;
    final generation = _generation;
    return (id) => (ids[id] ?? generation + 1) <= generation;
  }
}
