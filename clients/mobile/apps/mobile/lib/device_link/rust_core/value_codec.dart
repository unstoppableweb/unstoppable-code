import 'dart:collection';
import 'dart:convert';
import 'dart:typed_data';

import '../desktop/message_codec.dart';

/// Converts desktop values between the Dart transport's representation and
/// the Rust core's JSON bridge (`codec.rs`). A tag is an object with exactly
/// one of these shapes; every other object is a plain object:
///
/// - `{"$bytes": base64}`, `{"$date": ms}`, `{"$undefined": true}`,
///   `{"$number": "NaN"|"Infinity"|"-Infinity"}`;
/// - `{"$utf16": [code units]}`: a string with an unpaired surrogate;
/// - `{"$sparse": [...]}`: a V8 holey array (a fixed-length list);
/// - `{"$object": [[key, value], ...]}`: a map that has no plain JSON form
///   (it would read as a tag, a key has an unpaired surrogate, or keys
///   repeat);
/// - `{"$id": n, "$value": ...}` defines object `n`, and `{"$ref": n}` is the
///   same object again, so shared and cyclic values keep their identity.
///
/// [encodeRustValue] accepts exactly what the Dart V8 writer accepts
/// (`message_codec.dart` `_Writer.value`), with the same depth limit, and
/// throws [FormatException] for the rest. [decodeRustValue] returns the
/// object graph the V8 reader (`_Reader.value`) returns.

const _bytesKey = r'$bytes';
const _dateKey = r'$date';
const _undefinedKey = r'$undefined';
const _numberKey = r'$number';
const _utf16Key = r'$utf16';
const _sparseKey = r'$sparse';
const _objectKey = r'$object';
const _refKey = r'$ref';
const _idKey = r'$id';
const _valueKey = r'$value';
const _singleKeyTags = {
  _bytesKey,
  _dateKey,
  _undefinedKey,
  _numberKey,
  _utf16Key,
  _sparseKey,
  _objectKey,
  _refKey,
};

/// `codec.rs` `is_tag`: the object shapes the bridge reserves.
bool _isTag(Map<String, dynamic> map) => switch (map.length) {
  1 => _singleKeyTags.contains(map.keys.first),
  2 => map.containsKey(_idKey) && map.containsKey(_valueKey),
  _ => false,
};

/// The V8 writer's nesting limit (`message_codec.dart:123`).
const _maxDepth = 128;

/// Dart's `_Writer.value` message for both depth and size (`message_codec.dart:124`).
const _tooLarge = 'Desktop value is too large or nested.';

/// A Dart value as the Rust bridge expects it. [depth] is the V8 depth of
/// [value] in its message: `ipc.invoke` arguments are a list at depth 2
/// (`{kind, id, method, params: {channel, args}}`), as Dart's writer counts.
/// Throws [FormatException] for values the Dart V8 writer rejects.
Object? encodeRustValue(Object? value, {int depth = 0}) {
  final shared = _sharedObjects(value);
  return _Encoder(shared).value(value, depth);
}

bool _referenceable(Object? v) =>
    v is Uint8List || v is DateTime || v is List || v is Map<String, dynamic>;

/// Objects reached more than once (shared or cyclic): only they need ids.
Set<Object> _sharedObjects(Object? root) {
  final seen = HashSet<Object>.identity();
  final shared = HashSet<Object>.identity();
  final pending = <Object?>[root];
  while (pending.isNotEmpty) {
    final v = pending.removeLast();
    if (v == null || !_referenceable(v)) continue;
    if (!seen.add(v)) {
      shared.add(v);
      continue;
    }
    if (v is Uint8List) continue;
    if (v is List) pending.addAll(v);
    if (v is Map<String, dynamic>) pending.addAll(v.values);
  }
  return shared;
}

final class _Encoder {
  _Encoder(this._shared);
  final Set<Object> _shared;
  final _ids = HashMap<Object, int>.identity();

  Object? value(Object? v, int depth) {
    if (depth > _maxDepth) throw const FormatException(_tooLarge);
    if (v == null) return null;
    if (identical(v, desktopUndefined)) return const {_undefinedKey: true};
    if (v is bool) return v;
    if (v is int && v >= -2147483648 && v <= 2147483647) return v;
    if (v is num) {
      // The writer sends every other number as a float64 (`N`).
      final number = v.toDouble();
      if (number.isNaN) return const {_numberKey: 'NaN'};
      if (number == double.infinity) return const {_numberKey: 'Infinity'};
      if (number == double.negativeInfinity) {
        return const {_numberKey: '-Infinity'};
      }
      return number;
    }
    if (v is String) return _wellFormed(v);
    if (_ids[v] case final id?) return {_refKey: id};
    if (!_referenceable(v)) {
      throw const FormatException('Unsupported desktop value type.');
    }
    // An id is taken before the children, so a cycle refers back to it.
    final id = _shared.contains(v) ? (_ids[v] = _ids.length) : null;
    final Object encoded;
    if (v is Uint8List) {
      encoded = {_bytesKey: base64.encode(v)};
    } else if (v is DateTime) {
      encoded = {_dateKey: v.millisecondsSinceEpoch};
    } else if (v is List) {
      encoded = [for (final e in v) value(e, depth + 1)];
    } else {
      encoded = _map(v as Map<String, dynamic>, depth);
    }
    return id == null ? encoded : {_idKey: id, _valueKey: encoded};
  }

  Object _map(Map<String, dynamic> v, int depth) {
    final entries = <(String, Object?)>[];
    final keys = <String>{};
    var plain = true;
    for (final entry in v.entries) {
      // The writer checks the key's depth too.
      if (depth + 1 > _maxDepth) throw const FormatException(_tooLarge);
      final key = _wellFormed(entry.key);
      // Two keys can become equal once unpaired surrogates are replaced; the
      // writer still sends both.
      if (!keys.add(key)) plain = false;
      entries.add((key, value(entry.value, depth + 1)));
    }
    final map = {for (final (key, value) in entries) key: value};
    if (plain && !_isTag(map)) return map;
    return {
      _objectKey: [
        for (final (key, value) in entries) [key, value],
      ],
    };
  }
}

/// The writer sends strings as UTF-8 (`utf8.encode`), which turns an unpaired
/// surrogate into U+FFFD. JSON escapes would keep the surrogate and the
/// bridge would refuse it, so replace it here with the same result.
String _wellFormed(String value) {
  for (var i = 0; i < value.length; i++) {
    final unit = value.codeUnitAt(i);
    if (unit >= 0xD800 && unit <= 0xDFFF) {
      return utf8.decode(utf8.encode(value));
    }
  }
  return value;
}

/// A bridge value as the Dart V8 reader would have returned it: maps are
/// `Map<String, dynamic>` in wire order, lists are `List<Object?>` (holey
/// arrays fixed-length), bytes are [Uint8List], dates UTC [DateTime],
/// undefined is [desktopUndefined], and shared or cyclic objects are the same
/// object. Throws [FormatException] for a malformed bridge value.
Object? decodeRustValue(Object? value) => _Decoder().value(value);

final class _Decoder {
  final _refs = <int, Object>{};

  Object? value(Object? v) {
    if (v is List) return <Object?>[for (final e in v) value(e)];
    if (v is! Map<String, dynamic>) return v;
    if (!_isTag(v)) {
      return <String, dynamic>{
        for (final entry in v.entries) entry.key: value(entry.value),
      };
    }
    if (v.length == 2) return _define(v[_idKey], v[_valueKey]);
    final key = v.keys.first;
    final tagged = v[key];
    switch (key) {
      case _refKey when tagged is int:
        return _refs[tagged] ?? (throw const FormatException('Unknown ref.'));
      case _sparseKey when tagged is List:
        return _fill(List<Object?>.filled(tagged.length, desktopUndefined), v);
      case _objectKey when tagged is List:
        return _fill(<String, dynamic>{}, v);
    }
    return _leaf(key, tagged);
  }

  Object? _leaf(String key, Object? tagged) {
    switch (key) {
      case _bytesKey when tagged is String:
        return base64.decode(tagged);
      case _dateKey when tagged is int:
        return DateTime.fromMillisecondsSinceEpoch(tagged, isUtc: true);
      case _undefinedKey when tagged == true:
        return desktopUndefined;
      case _numberKey when tagged == 'NaN':
        return double.nan;
      case _numberKey when tagged == 'Infinity':
        return double.infinity;
      case _numberKey when tagged == '-Infinity':
        return double.negativeInfinity;
      case _utf16Key when tagged is List:
        return _units(tagged);
    }
    throw const FormatException('Malformed desktop value.');
  }

  /// `{"$id": id, "$value": value}`: the object is registered before its
  /// children are read, as the V8 reader does, so cycles resolve to it.
  Object _define(Object? id, Object? v) {
    if (id is! int || _refs.containsKey(id)) {
      throw const FormatException('Malformed desktop value.');
    }
    final Object container;
    if (v is List) {
      container = <Object?>[];
    } else if (v is Map<String, dynamic> && !_isTag(v)) {
      container = <String, dynamic>{};
    } else if (v case {_sparseKey: final List items} when v.length == 1) {
      container = List<Object?>.filled(items.length, desktopUndefined);
    } else if (v case {_objectKey: List()} when v.length == 1) {
      container = <String, dynamic>{};
    } else if (v case {_dateKey: final Object? tagged} when v.length == 1) {
      return _refs[id] = _leaf(_dateKey, tagged)!;
    } else if (v case {_bytesKey: final Object? tagged} when v.length == 1) {
      return _refs[id] = _leaf(_bytesKey, tagged)!;
    } else {
      throw const FormatException('Malformed desktop value.');
    }
    _refs[id] = container;
    return _fill(container, v);
  }

  Object _fill(Object container, Object? v) {
    if (container is List<Object?> && v is List) {
      for (final e in v) {
        container.add(value(e));
      }
    } else if (container is List<Object?>) {
      final items = (v as Map)[_sparseKey] as List;
      for (var i = 0; i < items.length; i++) {
        container[i] = value(items[i]);
      }
    } else if (container is Map<String, dynamic> && _isTagged(v)) {
      for (final pair in (v as Map)[_objectKey] as List) {
        if (pair is! List || pair.length != 2) {
          throw const FormatException('Malformed desktop value.');
        }
        final key = pair[0];
        final name = key is String
            ? key
            : key is Map<String, dynamic> && key.length == 1
            ? _leaf(_utf16Key, key[_utf16Key]) as String
            : throw const FormatException('Malformed desktop value.');
        container[name] = value(pair[1]);
      }
    } else if (container is Map<String, dynamic> && v is Map<String, dynamic>) {
      for (final entry in v.entries) {
        container[entry.key] = value(entry.value);
      }
    }
    return container;
  }

  static bool _isTagged(Object? v) => v is Map<String, dynamic> && _isTag(v);

  static String _units(List<Object?> units) => String.fromCharCodes([
    for (final unit in units)
      if (unit is int && unit >= 0 && unit <= 0xFFFF)
        unit
      else
        throw const FormatException('Malformed desktop value.'),
  ]);
}
