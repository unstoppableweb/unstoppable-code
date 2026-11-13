import 'dart:collection';
import 'dart:math' as math;

/// Immutable transcript snapshots can report a changed suffix without comparing
/// every historical message. Null asks consumers to compare rows normally.
abstract class TranscriptList<T> extends ListBase<T> {
  int? firstChangeSince(Object previous);

  @override
  set length(int value) => throw UnsupportedError('Immutable transcript');
  @override
  void operator []=(int index, T value) =>
      throw UnsupportedError('Immutable transcript');
}

/// Mutable storage with copy-on-write chunks. Publishing is constant time;
/// appends and revisions copy one small chunk and the chunk-reference table.
/// Infrequent middle inserts/removals rebuild storage in transcript order.
class TranscriptBuffer<T> extends ListBase<T> {
  static const _chunkSize = 128;
  final _history = _ChangeHistory();
  late _ChunkSnapshot<T> _snapshot = _ChunkSnapshot([], 0, _history, 0);

  TranscriptBuffer([Iterable<T> rows = const []]) {
    _replace(rows);
  }

  TranscriptList<T> get snapshot => _snapshot;
  @override
  int get length => _snapshot.length;
  @override
  T operator [](int index) => _snapshot[index];

  @override
  set length(int value) {
    RangeError.checkValueInInterval(value, 0, length, 'length');
    if (value != length) _replace(take(value));
  }

  @override
  void operator []=(int index, T value) {
    RangeError.checkValidIndex(index, this);
    if (identical(this[index], value)) return;
    final chunks = [..._snapshot.chunks];
    chunks[index ~/ _chunkSize] = [...chunks[index ~/ _chunkSize]]
      ..[index % _chunkSize] = value;
    _publish(chunks, length, index);
  }

  @override
  void add(T element) {
    final chunks = [..._snapshot.chunks];
    if (length % _chunkSize == 0) {
      chunks.add([element]);
    } else {
      chunks[chunks.length - 1] = [...chunks.last, element];
    }
    _publish(chunks, length + 1, length);
  }

  @override
  void insert(int index, T element) {
    RangeError.checkValueInInterval(index, 0, length, 'index');
    if (index == length) {
      add(element);
    } else {
      _replace([...take(index), element, ...skip(index)]);
    }
  }

  @override
  T removeAt(int index) {
    final removed = this[index];
    _replace([...take(index), ...skip(index + 1)]);
    return removed;
  }

  @override
  void removeWhere(bool Function(T) test) {
    final kept = where((row) => !test(row)).toList();
    if (kept.length != length) _replace(kept);
  }

  void _replace(Iterable<T> rows) {
    final values = rows.toList();
    final chunks = <List<T>>[
      for (var i = 0; i < values.length; i += _chunkSize)
        values.sublist(i, math.min(i + _chunkSize, values.length)),
    ];
    _publish(chunks, values.length, 0);
  }

  void _publish(List<List<T>> chunks, int length, int firstChanged) {
    final revision = _history.record(firstChanged);
    _snapshot = _ChunkSnapshot(chunks, length, _history, revision);
  }
}

/// A snapshot of stored rows followed by a small optimistic/delivery tail.
/// Neither list may be mutable. Only the tail is compared when the base is
/// unchanged, including when a send is removed before the next projection.
class JoinedTranscript<T> extends TranscriptList<T> {
  JoinedTranscript(this.base, Iterable<T> tail)
    : tail = List.unmodifiable(tail);

  final List<T> base;
  final List<T> tail;

  @override
  int get length => base.length + tail.length;
  @override
  T operator [](int index) {
    RangeError.checkValidIndex(index, this);
    return index < base.length ? base[index] : tail[index - base.length];
  }

  @override
  int? firstChangeSince(Object previous) {
    if (previous is! JoinedTranscript<T>) return null;
    final int? changed;
    if (identical(base, previous.base)) {
      changed = base.length;
    } else if (base case final TranscriptList<T> tracked) {
      changed = tracked.firstChangeSince(previous.base);
    } else {
      return null;
    }
    if (changed == null) return null;
    if (changed < base.length || base.length != previous.base.length) {
      return math.min(changed, previous.base.length);
    }
    var i = 0;
    while (i < tail.length &&
        i < previous.tail.length &&
        identical(tail[i], previous.tail[i])) {
      i++;
    }
    return base.length + i;
  }
}

class _ChunkSnapshot<T> extends TranscriptList<T> {
  _ChunkSnapshot(this.chunks, this.length, this.history, this.revision);

  final List<List<T>> chunks;
  @override
  final int length;
  final _ChangeHistory history;
  final int revision;

  @override
  T operator [](int index) {
    RangeError.checkValidIndex(index, this);
    return chunks[index ~/ TranscriptBuffer._chunkSize][index %
        TranscriptBuffer._chunkSize];
  }

  @override
  int? firstChangeSince(Object previous) {
    if (previous is! _ChunkSnapshot<T> ||
        !identical(history, previous.history)) {
      return null;
    }
    if (previous.revision == revision) return length;
    return history.firstChange(previous.revision, revision);
  }
}

/// Bounded metadata only; snapshots never retain a chain of old transcripts.
class _ChangeHistory {
  int _revision = 0;
  final _changes = <int, int>{};

  int record(int firstChanged) {
    _changes[++_revision] = firstChanged;
    _changes.remove(_revision - 64);
    return _revision;
  }

  int? firstChange(int previous, int current) {
    if (previous >= current || !_changes.containsKey(previous + 1)) return null;
    var first = _changes[previous + 1]!;
    for (var revision = previous + 2; revision <= current; revision++) {
      final changed = _changes[revision];
      if (changed == null) return null;
      first = math.min(first, changed);
    }
    return first;
  }
}
