/// One computer the account saved: its device ID, name and whether it
/// reconnects on its own.
final class SavedComputer {
  const SavedComputer(this.id, this.name, {this.reconnect = true});
  final String id, name;
  final bool reconnect;
  Map<String, Object> toJson() => {
    'id': id,
    'name': name,
    'reconnect': reconnect,
  };
}
