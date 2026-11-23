// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'bridge.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;
/// @nodoc
mixin _$BridgeEvent {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is BridgeEvent);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'BridgeEvent()';
}


}

/// @nodoc
class $BridgeEventCopyWith<$Res>  {
$BridgeEventCopyWith(BridgeEvent _, $Res Function(BridgeEvent) __);
}


/// Adds pattern-matching-related methods to [BridgeEvent].
extension BridgeEventPatterns on BridgeEvent {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( BridgeEvent_PairingCode value)?  pairingCode,TResult Function( BridgeEvent_Message value)?  message,TResult Function( BridgeEvent_Closed value)?  closed,TResult Function( BridgeEvent_RelayOpened value)?  relayOpened,TResult Function( BridgeEvent_RelayClosed value)?  relayClosed,TResult Function( BridgeEvent_Peers value)?  peers,required TResult orElse(),}){
final _that = this;
switch (_that) {
case BridgeEvent_PairingCode() when pairingCode != null:
return pairingCode(_that);case BridgeEvent_Message() when message != null:
return message(_that);case BridgeEvent_Closed() when closed != null:
return closed(_that);case BridgeEvent_RelayOpened() when relayOpened != null:
return relayOpened(_that);case BridgeEvent_RelayClosed() when relayClosed != null:
return relayClosed(_that);case BridgeEvent_Peers() when peers != null:
return peers(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( BridgeEvent_PairingCode value)  pairingCode,required TResult Function( BridgeEvent_Message value)  message,required TResult Function( BridgeEvent_Closed value)  closed,required TResult Function( BridgeEvent_RelayOpened value)  relayOpened,required TResult Function( BridgeEvent_RelayClosed value)  relayClosed,required TResult Function( BridgeEvent_Peers value)  peers,}){
final _that = this;
switch (_that) {
case BridgeEvent_PairingCode():
return pairingCode(_that);case BridgeEvent_Message():
return message(_that);case BridgeEvent_Closed():
return closed(_that);case BridgeEvent_RelayOpened():
return relayOpened(_that);case BridgeEvent_RelayClosed():
return relayClosed(_that);case BridgeEvent_Peers():
return peers(_that);}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( BridgeEvent_PairingCode value)?  pairingCode,TResult? Function( BridgeEvent_Message value)?  message,TResult? Function( BridgeEvent_Closed value)?  closed,TResult? Function( BridgeEvent_RelayOpened value)?  relayOpened,TResult? Function( BridgeEvent_RelayClosed value)?  relayClosed,TResult? Function( BridgeEvent_Peers value)?  peers,}){
final _that = this;
switch (_that) {
case BridgeEvent_PairingCode() when pairingCode != null:
return pairingCode(_that);case BridgeEvent_Message() when message != null:
return message(_that);case BridgeEvent_Closed() when closed != null:
return closed(_that);case BridgeEvent_RelayOpened() when relayOpened != null:
return relayOpened(_that);case BridgeEvent_RelayClosed() when relayClosed != null:
return relayClosed(_that);case BridgeEvent_Peers() when peers != null:
return peers(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( String computerId,  String code)?  pairingCode,TResult Function( String computerId,  String messageJson)?  message,TResult Function( String computerId,  String code,  String reason)?  closed,TResult Function( String peersJson)?  relayOpened,TResult Function( String reason)?  relayClosed,TResult Function( String peersJson)?  peers,required TResult orElse(),}) {final _that = this;
switch (_that) {
case BridgeEvent_PairingCode() when pairingCode != null:
return pairingCode(_that.computerId,_that.code);case BridgeEvent_Message() when message != null:
return message(_that.computerId,_that.messageJson);case BridgeEvent_Closed() when closed != null:
return closed(_that.computerId,_that.code,_that.reason);case BridgeEvent_RelayOpened() when relayOpened != null:
return relayOpened(_that.peersJson);case BridgeEvent_RelayClosed() when relayClosed != null:
return relayClosed(_that.reason);case BridgeEvent_Peers() when peers != null:
return peers(_that.peersJson);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( String computerId,  String code)  pairingCode,required TResult Function( String computerId,  String messageJson)  message,required TResult Function( String computerId,  String code,  String reason)  closed,required TResult Function( String peersJson)  relayOpened,required TResult Function( String reason)  relayClosed,required TResult Function( String peersJson)  peers,}) {final _that = this;
switch (_that) {
case BridgeEvent_PairingCode():
return pairingCode(_that.computerId,_that.code);case BridgeEvent_Message():
return message(_that.computerId,_that.messageJson);case BridgeEvent_Closed():
return closed(_that.computerId,_that.code,_that.reason);case BridgeEvent_RelayOpened():
return relayOpened(_that.peersJson);case BridgeEvent_RelayClosed():
return relayClosed(_that.reason);case BridgeEvent_Peers():
return peers(_that.peersJson);}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( String computerId,  String code)?  pairingCode,TResult? Function( String computerId,  String messageJson)?  message,TResult? Function( String computerId,  String code,  String reason)?  closed,TResult? Function( String peersJson)?  relayOpened,TResult? Function( String reason)?  relayClosed,TResult? Function( String peersJson)?  peers,}) {final _that = this;
switch (_that) {
case BridgeEvent_PairingCode() when pairingCode != null:
return pairingCode(_that.computerId,_that.code);case BridgeEvent_Message() when message != null:
return message(_that.computerId,_that.messageJson);case BridgeEvent_Closed() when closed != null:
return closed(_that.computerId,_that.code,_that.reason);case BridgeEvent_RelayOpened() when relayOpened != null:
return relayOpened(_that.peersJson);case BridgeEvent_RelayClosed() when relayClosed != null:
return relayClosed(_that.reason);case BridgeEvent_Peers() when peers != null:
return peers(_that.peersJson);case _:
  return null;

}
}

}

/// @nodoc


class BridgeEvent_PairingCode extends BridgeEvent {
  const BridgeEvent_PairingCode({required this.computerId, required this.code}): super._();
  

 final  String computerId;
 final  String code;

/// Create a copy of BridgeEvent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$BridgeEvent_PairingCodeCopyWith<BridgeEvent_PairingCode> get copyWith => _$BridgeEvent_PairingCodeCopyWithImpl<BridgeEvent_PairingCode>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is BridgeEvent_PairingCode&&(identical(other.computerId, computerId) || other.computerId == computerId)&&(identical(other.code, code) || other.code == code));
}


@override
int get hashCode => Object.hash(runtimeType,computerId,code);

@override
String toString() {
  return 'BridgeEvent.pairingCode(computerId: $computerId, code: $code)';
}


}

/// @nodoc
abstract mixin class $BridgeEvent_PairingCodeCopyWith<$Res> implements $BridgeEventCopyWith<$Res> {
  factory $BridgeEvent_PairingCodeCopyWith(BridgeEvent_PairingCode value, $Res Function(BridgeEvent_PairingCode) _then) = _$BridgeEvent_PairingCodeCopyWithImpl;
@useResult
$Res call({
 String computerId, String code
});




}
/// @nodoc
class _$BridgeEvent_PairingCodeCopyWithImpl<$Res>
    implements $BridgeEvent_PairingCodeCopyWith<$Res> {
  _$BridgeEvent_PairingCodeCopyWithImpl(this._self, this._then);

  final BridgeEvent_PairingCode _self;
  final $Res Function(BridgeEvent_PairingCode) _then;

/// Create a copy of BridgeEvent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? computerId = null,Object? code = null,}) {
  return _then(BridgeEvent_PairingCode(
computerId: null == computerId ? _self.computerId : computerId // ignore: cast_nullable_to_non_nullable
as String,code: null == code ? _self.code : code // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class BridgeEvent_Message extends BridgeEvent {
  const BridgeEvent_Message({required this.computerId, required this.messageJson}): super._();
  

 final  String computerId;
 final  String messageJson;

/// Create a copy of BridgeEvent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$BridgeEvent_MessageCopyWith<BridgeEvent_Message> get copyWith => _$BridgeEvent_MessageCopyWithImpl<BridgeEvent_Message>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is BridgeEvent_Message&&(identical(other.computerId, computerId) || other.computerId == computerId)&&(identical(other.messageJson, messageJson) || other.messageJson == messageJson));
}


@override
int get hashCode => Object.hash(runtimeType,computerId,messageJson);

@override
String toString() {
  return 'BridgeEvent.message(computerId: $computerId, messageJson: $messageJson)';
}


}

/// @nodoc
abstract mixin class $BridgeEvent_MessageCopyWith<$Res> implements $BridgeEventCopyWith<$Res> {
  factory $BridgeEvent_MessageCopyWith(BridgeEvent_Message value, $Res Function(BridgeEvent_Message) _then) = _$BridgeEvent_MessageCopyWithImpl;
@useResult
$Res call({
 String computerId, String messageJson
});




}
/// @nodoc
class _$BridgeEvent_MessageCopyWithImpl<$Res>
    implements $BridgeEvent_MessageCopyWith<$Res> {
  _$BridgeEvent_MessageCopyWithImpl(this._self, this._then);

  final BridgeEvent_Message _self;
  final $Res Function(BridgeEvent_Message) _then;

/// Create a copy of BridgeEvent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? computerId = null,Object? messageJson = null,}) {
  return _then(BridgeEvent_Message(
computerId: null == computerId ? _self.computerId : computerId // ignore: cast_nullable_to_non_nullable
as String,messageJson: null == messageJson ? _self.messageJson : messageJson // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class BridgeEvent_Closed extends BridgeEvent {
  const BridgeEvent_Closed({required this.computerId, required this.code, required this.reason}): super._();
  

 final  String computerId;
 final  String code;
 final  String reason;

/// Create a copy of BridgeEvent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$BridgeEvent_ClosedCopyWith<BridgeEvent_Closed> get copyWith => _$BridgeEvent_ClosedCopyWithImpl<BridgeEvent_Closed>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is BridgeEvent_Closed&&(identical(other.computerId, computerId) || other.computerId == computerId)&&(identical(other.code, code) || other.code == code)&&(identical(other.reason, reason) || other.reason == reason));
}


@override
int get hashCode => Object.hash(runtimeType,computerId,code,reason);

@override
String toString() {
  return 'BridgeEvent.closed(computerId: $computerId, code: $code, reason: $reason)';
}


}

/// @nodoc
abstract mixin class $BridgeEvent_ClosedCopyWith<$Res> implements $BridgeEventCopyWith<$Res> {
  factory $BridgeEvent_ClosedCopyWith(BridgeEvent_Closed value, $Res Function(BridgeEvent_Closed) _then) = _$BridgeEvent_ClosedCopyWithImpl;
@useResult
$Res call({
 String computerId, String code, String reason
});




}
/// @nodoc
class _$BridgeEvent_ClosedCopyWithImpl<$Res>
    implements $BridgeEvent_ClosedCopyWith<$Res> {
  _$BridgeEvent_ClosedCopyWithImpl(this._self, this._then);

  final BridgeEvent_Closed _self;
  final $Res Function(BridgeEvent_Closed) _then;

/// Create a copy of BridgeEvent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? computerId = null,Object? code = null,Object? reason = null,}) {
  return _then(BridgeEvent_Closed(
computerId: null == computerId ? _self.computerId : computerId // ignore: cast_nullable_to_non_nullable
as String,code: null == code ? _self.code : code // ignore: cast_nullable_to_non_nullable
as String,reason: null == reason ? _self.reason : reason // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class BridgeEvent_RelayOpened extends BridgeEvent {
  const BridgeEvent_RelayOpened({required this.peersJson}): super._();
  

 final  String peersJson;

/// Create a copy of BridgeEvent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$BridgeEvent_RelayOpenedCopyWith<BridgeEvent_RelayOpened> get copyWith => _$BridgeEvent_RelayOpenedCopyWithImpl<BridgeEvent_RelayOpened>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is BridgeEvent_RelayOpened&&(identical(other.peersJson, peersJson) || other.peersJson == peersJson));
}


@override
int get hashCode => Object.hash(runtimeType,peersJson);

@override
String toString() {
  return 'BridgeEvent.relayOpened(peersJson: $peersJson)';
}


}

/// @nodoc
abstract mixin class $BridgeEvent_RelayOpenedCopyWith<$Res> implements $BridgeEventCopyWith<$Res> {
  factory $BridgeEvent_RelayOpenedCopyWith(BridgeEvent_RelayOpened value, $Res Function(BridgeEvent_RelayOpened) _then) = _$BridgeEvent_RelayOpenedCopyWithImpl;
@useResult
$Res call({
 String peersJson
});




}
/// @nodoc
class _$BridgeEvent_RelayOpenedCopyWithImpl<$Res>
    implements $BridgeEvent_RelayOpenedCopyWith<$Res> {
  _$BridgeEvent_RelayOpenedCopyWithImpl(this._self, this._then);

  final BridgeEvent_RelayOpened _self;
  final $Res Function(BridgeEvent_RelayOpened) _then;

/// Create a copy of BridgeEvent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? peersJson = null,}) {
  return _then(BridgeEvent_RelayOpened(
peersJson: null == peersJson ? _self.peersJson : peersJson // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class BridgeEvent_RelayClosed extends BridgeEvent {
  const BridgeEvent_RelayClosed({required this.reason}): super._();
  

 final  String reason;

/// Create a copy of BridgeEvent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$BridgeEvent_RelayClosedCopyWith<BridgeEvent_RelayClosed> get copyWith => _$BridgeEvent_RelayClosedCopyWithImpl<BridgeEvent_RelayClosed>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is BridgeEvent_RelayClosed&&(identical(other.reason, reason) || other.reason == reason));
}


@override
int get hashCode => Object.hash(runtimeType,reason);

@override
String toString() {
  return 'BridgeEvent.relayClosed(reason: $reason)';
}


}

/// @nodoc
abstract mixin class $BridgeEvent_RelayClosedCopyWith<$Res> implements $BridgeEventCopyWith<$Res> {
  factory $BridgeEvent_RelayClosedCopyWith(BridgeEvent_RelayClosed value, $Res Function(BridgeEvent_RelayClosed) _then) = _$BridgeEvent_RelayClosedCopyWithImpl;
@useResult
$Res call({
 String reason
});




}
/// @nodoc
class _$BridgeEvent_RelayClosedCopyWithImpl<$Res>
    implements $BridgeEvent_RelayClosedCopyWith<$Res> {
  _$BridgeEvent_RelayClosedCopyWithImpl(this._self, this._then);

  final BridgeEvent_RelayClosed _self;
  final $Res Function(BridgeEvent_RelayClosed) _then;

/// Create a copy of BridgeEvent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? reason = null,}) {
  return _then(BridgeEvent_RelayClosed(
reason: null == reason ? _self.reason : reason // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class BridgeEvent_Peers extends BridgeEvent {
  const BridgeEvent_Peers({required this.peersJson}): super._();
  

 final  String peersJson;

/// Create a copy of BridgeEvent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$BridgeEvent_PeersCopyWith<BridgeEvent_Peers> get copyWith => _$BridgeEvent_PeersCopyWithImpl<BridgeEvent_Peers>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is BridgeEvent_Peers&&(identical(other.peersJson, peersJson) || other.peersJson == peersJson));
}


@override
int get hashCode => Object.hash(runtimeType,peersJson);

@override
String toString() {
  return 'BridgeEvent.peers(peersJson: $peersJson)';
}


}

/// @nodoc
abstract mixin class $BridgeEvent_PeersCopyWith<$Res> implements $BridgeEventCopyWith<$Res> {
  factory $BridgeEvent_PeersCopyWith(BridgeEvent_Peers value, $Res Function(BridgeEvent_Peers) _then) = _$BridgeEvent_PeersCopyWithImpl;
@useResult
$Res call({
 String peersJson
});




}
/// @nodoc
class _$BridgeEvent_PeersCopyWithImpl<$Res>
    implements $BridgeEvent_PeersCopyWith<$Res> {
  _$BridgeEvent_PeersCopyWithImpl(this._self, this._then);

  final BridgeEvent_Peers _self;
  final $Res Function(BridgeEvent_Peers) _then;

/// Create a copy of BridgeEvent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? peersJson = null,}) {
  return _then(BridgeEvent_Peers(
peersJson: null == peersJson ? _self.peersJson : peersJson // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc
mixin _$BridgeMessage {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is BridgeMessage);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'BridgeMessage()';
}


}

/// @nodoc
class $BridgeMessageCopyWith<$Res>  {
$BridgeMessageCopyWith(BridgeMessage _, $Res Function(BridgeMessage) __);
}


/// Adds pattern-matching-related methods to [BridgeMessage].
extension BridgeMessagePatterns on BridgeMessage {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( BridgeMessage_Reply value)?  reply,TResult Function( BridgeMessage_Failed value)?  failed,TResult Function( BridgeMessage_Event value)?  event,required TResult orElse(),}){
final _that = this;
switch (_that) {
case BridgeMessage_Reply() when reply != null:
return reply(_that);case BridgeMessage_Failed() when failed != null:
return failed(_that);case BridgeMessage_Event() when event != null:
return event(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( BridgeMessage_Reply value)  reply,required TResult Function( BridgeMessage_Failed value)  failed,required TResult Function( BridgeMessage_Event value)  event,}){
final _that = this;
switch (_that) {
case BridgeMessage_Reply():
return reply(_that);case BridgeMessage_Failed():
return failed(_that);case BridgeMessage_Event():
return event(_that);}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( BridgeMessage_Reply value)?  reply,TResult? Function( BridgeMessage_Failed value)?  failed,TResult? Function( BridgeMessage_Event value)?  event,}){
final _that = this;
switch (_that) {
case BridgeMessage_Reply() when reply != null:
return reply(_that);case BridgeMessage_Failed() when failed != null:
return failed(_that);case BridgeMessage_Event() when event != null:
return event(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( int id,  String valueJson)?  reply,TResult Function( int id,  CoreFailure failure)?  failed,TResult Function( BridgeEvent field0)?  event,required TResult orElse(),}) {final _that = this;
switch (_that) {
case BridgeMessage_Reply() when reply != null:
return reply(_that.id,_that.valueJson);case BridgeMessage_Failed() when failed != null:
return failed(_that.id,_that.failure);case BridgeMessage_Event() when event != null:
return event(_that.field0);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( int id,  String valueJson)  reply,required TResult Function( int id,  CoreFailure failure)  failed,required TResult Function( BridgeEvent field0)  event,}) {final _that = this;
switch (_that) {
case BridgeMessage_Reply():
return reply(_that.id,_that.valueJson);case BridgeMessage_Failed():
return failed(_that.id,_that.failure);case BridgeMessage_Event():
return event(_that.field0);}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( int id,  String valueJson)?  reply,TResult? Function( int id,  CoreFailure failure)?  failed,TResult? Function( BridgeEvent field0)?  event,}) {final _that = this;
switch (_that) {
case BridgeMessage_Reply() when reply != null:
return reply(_that.id,_that.valueJson);case BridgeMessage_Failed() when failed != null:
return failed(_that.id,_that.failure);case BridgeMessage_Event() when event != null:
return event(_that.field0);case _:
  return null;

}
}

}

/// @nodoc


class BridgeMessage_Reply extends BridgeMessage {
  const BridgeMessage_Reply({required this.id, required this.valueJson}): super._();
  

 final  int id;
 final  String valueJson;

/// Create a copy of BridgeMessage
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$BridgeMessage_ReplyCopyWith<BridgeMessage_Reply> get copyWith => _$BridgeMessage_ReplyCopyWithImpl<BridgeMessage_Reply>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is BridgeMessage_Reply&&(identical(other.id, id) || other.id == id)&&(identical(other.valueJson, valueJson) || other.valueJson == valueJson));
}


@override
int get hashCode => Object.hash(runtimeType,id,valueJson);

@override
String toString() {
  return 'BridgeMessage.reply(id: $id, valueJson: $valueJson)';
}


}

/// @nodoc
abstract mixin class $BridgeMessage_ReplyCopyWith<$Res> implements $BridgeMessageCopyWith<$Res> {
  factory $BridgeMessage_ReplyCopyWith(BridgeMessage_Reply value, $Res Function(BridgeMessage_Reply) _then) = _$BridgeMessage_ReplyCopyWithImpl;
@useResult
$Res call({
 int id, String valueJson
});




}
/// @nodoc
class _$BridgeMessage_ReplyCopyWithImpl<$Res>
    implements $BridgeMessage_ReplyCopyWith<$Res> {
  _$BridgeMessage_ReplyCopyWithImpl(this._self, this._then);

  final BridgeMessage_Reply _self;
  final $Res Function(BridgeMessage_Reply) _then;

/// Create a copy of BridgeMessage
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? id = null,Object? valueJson = null,}) {
  return _then(BridgeMessage_Reply(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as int,valueJson: null == valueJson ? _self.valueJson : valueJson // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class BridgeMessage_Failed extends BridgeMessage {
  const BridgeMessage_Failed({required this.id, required this.failure}): super._();
  

 final  int id;
 final  CoreFailure failure;

/// Create a copy of BridgeMessage
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$BridgeMessage_FailedCopyWith<BridgeMessage_Failed> get copyWith => _$BridgeMessage_FailedCopyWithImpl<BridgeMessage_Failed>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is BridgeMessage_Failed&&(identical(other.id, id) || other.id == id)&&(identical(other.failure, failure) || other.failure == failure));
}


@override
int get hashCode => Object.hash(runtimeType,id,failure);

@override
String toString() {
  return 'BridgeMessage.failed(id: $id, failure: $failure)';
}


}

/// @nodoc
abstract mixin class $BridgeMessage_FailedCopyWith<$Res> implements $BridgeMessageCopyWith<$Res> {
  factory $BridgeMessage_FailedCopyWith(BridgeMessage_Failed value, $Res Function(BridgeMessage_Failed) _then) = _$BridgeMessage_FailedCopyWithImpl;
@useResult
$Res call({
 int id, CoreFailure failure
});




}
/// @nodoc
class _$BridgeMessage_FailedCopyWithImpl<$Res>
    implements $BridgeMessage_FailedCopyWith<$Res> {
  _$BridgeMessage_FailedCopyWithImpl(this._self, this._then);

  final BridgeMessage_Failed _self;
  final $Res Function(BridgeMessage_Failed) _then;

/// Create a copy of BridgeMessage
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? id = null,Object? failure = null,}) {
  return _then(BridgeMessage_Failed(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as int,failure: null == failure ? _self.failure : failure // ignore: cast_nullable_to_non_nullable
as CoreFailure,
  ));
}


}

/// @nodoc


class BridgeMessage_Event extends BridgeMessage {
  const BridgeMessage_Event(this.field0): super._();
  

 final  BridgeEvent field0;

/// Create a copy of BridgeMessage
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$BridgeMessage_EventCopyWith<BridgeMessage_Event> get copyWith => _$BridgeMessage_EventCopyWithImpl<BridgeMessage_Event>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is BridgeMessage_Event&&(identical(other.field0, field0) || other.field0 == field0));
}


@override
int get hashCode => Object.hash(runtimeType,field0);

@override
String toString() {
  return 'BridgeMessage.event(field0: $field0)';
}


}

/// @nodoc
abstract mixin class $BridgeMessage_EventCopyWith<$Res> implements $BridgeMessageCopyWith<$Res> {
  factory $BridgeMessage_EventCopyWith(BridgeMessage_Event value, $Res Function(BridgeMessage_Event) _then) = _$BridgeMessage_EventCopyWithImpl;
@useResult
$Res call({
 BridgeEvent field0
});


$BridgeEventCopyWith<$Res> get field0;

}
/// @nodoc
class _$BridgeMessage_EventCopyWithImpl<$Res>
    implements $BridgeMessage_EventCopyWith<$Res> {
  _$BridgeMessage_EventCopyWithImpl(this._self, this._then);

  final BridgeMessage_Event _self;
  final $Res Function(BridgeMessage_Event) _then;

/// Create a copy of BridgeMessage
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? field0 = null,}) {
  return _then(BridgeMessage_Event(
null == field0 ? _self.field0 : field0 // ignore: cast_nullable_to_non_nullable
as BridgeEvent,
  ));
}

/// Create a copy of BridgeMessage
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$BridgeEventCopyWith<$Res> get field0 {
  
  return $BridgeEventCopyWith<$Res>(_self.field0, (value) {
    return _then(_self.copyWith(field0: value));
  });
}
}

/// @nodoc
mixin _$IdentityImport {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is IdentityImport);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'IdentityImport()';
}


}

/// @nodoc
class $IdentityImportCopyWith<$Res>  {
$IdentityImportCopyWith(IdentityImport _, $Res Function(IdentityImport) __);
}


/// Adds pattern-matching-related methods to [IdentityImport].
extension IdentityImportPatterns on IdentityImport {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( IdentityImport_DartRecord value)?  dartRecord,TResult Function( IdentityImport_Seed value)?  seed,required TResult orElse(),}){
final _that = this;
switch (_that) {
case IdentityImport_DartRecord() when dartRecord != null:
return dartRecord(_that);case IdentityImport_Seed() when seed != null:
return seed(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( IdentityImport_DartRecord value)  dartRecord,required TResult Function( IdentityImport_Seed value)  seed,}){
final _that = this;
switch (_that) {
case IdentityImport_DartRecord():
return dartRecord(_that);case IdentityImport_Seed():
return seed(_that);}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( IdentityImport_DartRecord value)?  dartRecord,TResult? Function( IdentityImport_Seed value)?  seed,}){
final _that = this;
switch (_that) {
case IdentityImport_DartRecord() when dartRecord != null:
return dartRecord(_that);case IdentityImport_Seed() when seed != null:
return seed(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( String record)?  dartRecord,TResult Function( String seed,  String? pinsJson)?  seed,required TResult orElse(),}) {final _that = this;
switch (_that) {
case IdentityImport_DartRecord() when dartRecord != null:
return dartRecord(_that.record);case IdentityImport_Seed() when seed != null:
return seed(_that.seed,_that.pinsJson);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( String record)  dartRecord,required TResult Function( String seed,  String? pinsJson)  seed,}) {final _that = this;
switch (_that) {
case IdentityImport_DartRecord():
return dartRecord(_that.record);case IdentityImport_Seed():
return seed(_that.seed,_that.pinsJson);}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( String record)?  dartRecord,TResult? Function( String seed,  String? pinsJson)?  seed,}) {final _that = this;
switch (_that) {
case IdentityImport_DartRecord() when dartRecord != null:
return dartRecord(_that.record);case IdentityImport_Seed() when seed != null:
return seed(_that.seed,_that.pinsJson);case _:
  return null;

}
}

}

/// @nodoc


class IdentityImport_DartRecord extends IdentityImport {
  const IdentityImport_DartRecord({required this.record}): super._();
  

 final  String record;

/// Create a copy of IdentityImport
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$IdentityImport_DartRecordCopyWith<IdentityImport_DartRecord> get copyWith => _$IdentityImport_DartRecordCopyWithImpl<IdentityImport_DartRecord>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is IdentityImport_DartRecord&&(identical(other.record, record) || other.record == record));
}


@override
int get hashCode => Object.hash(runtimeType,record);

@override
String toString() {
  return 'IdentityImport.dartRecord(record: $record)';
}


}

/// @nodoc
abstract mixin class $IdentityImport_DartRecordCopyWith<$Res> implements $IdentityImportCopyWith<$Res> {
  factory $IdentityImport_DartRecordCopyWith(IdentityImport_DartRecord value, $Res Function(IdentityImport_DartRecord) _then) = _$IdentityImport_DartRecordCopyWithImpl;
@useResult
$Res call({
 String record
});




}
/// @nodoc
class _$IdentityImport_DartRecordCopyWithImpl<$Res>
    implements $IdentityImport_DartRecordCopyWith<$Res> {
  _$IdentityImport_DartRecordCopyWithImpl(this._self, this._then);

  final IdentityImport_DartRecord _self;
  final $Res Function(IdentityImport_DartRecord) _then;

/// Create a copy of IdentityImport
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? record = null,}) {
  return _then(IdentityImport_DartRecord(
record: null == record ? _self.record : record // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class IdentityImport_Seed extends IdentityImport {
  const IdentityImport_Seed({required this.seed, this.pinsJson}): super._();
  

 final  String seed;
 final  String? pinsJson;

/// Create a copy of IdentityImport
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$IdentityImport_SeedCopyWith<IdentityImport_Seed> get copyWith => _$IdentityImport_SeedCopyWithImpl<IdentityImport_Seed>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is IdentityImport_Seed&&(identical(other.seed, seed) || other.seed == seed)&&(identical(other.pinsJson, pinsJson) || other.pinsJson == pinsJson));
}


@override
int get hashCode => Object.hash(runtimeType,seed,pinsJson);

@override
String toString() {
  return 'IdentityImport.seed(seed: $seed, pinsJson: $pinsJson)';
}


}

/// @nodoc
abstract mixin class $IdentityImport_SeedCopyWith<$Res> implements $IdentityImportCopyWith<$Res> {
  factory $IdentityImport_SeedCopyWith(IdentityImport_Seed value, $Res Function(IdentityImport_Seed) _then) = _$IdentityImport_SeedCopyWithImpl;
@useResult
$Res call({
 String seed, String? pinsJson
});




}
/// @nodoc
class _$IdentityImport_SeedCopyWithImpl<$Res>
    implements $IdentityImport_SeedCopyWith<$Res> {
  _$IdentityImport_SeedCopyWithImpl(this._self, this._then);

  final IdentityImport_Seed _self;
  final $Res Function(IdentityImport_Seed) _then;

/// Create a copy of IdentityImport
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? seed = null,Object? pinsJson = freezed,}) {
  return _then(IdentityImport_Seed(
seed: null == seed ? _self.seed : seed // ignore: cast_nullable_to_non_nullable
as String,pinsJson: freezed == pinsJson ? _self.pinsJson : pinsJson // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}

/// @nodoc
mixin _$SessionCall {

 String get computerId;
/// Create a copy of SessionCall
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$SessionCallCopyWith<SessionCall> get copyWith => _$SessionCallCopyWithImpl<SessionCall>(this as SessionCall, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SessionCall&&(identical(other.computerId, computerId) || other.computerId == computerId));
}


@override
int get hashCode => Object.hash(runtimeType,computerId);

@override
String toString() {
  return 'SessionCall(computerId: $computerId)';
}


}

/// @nodoc
abstract mixin class $SessionCallCopyWith<$Res>  {
  factory $SessionCallCopyWith(SessionCall value, $Res Function(SessionCall) _then) = _$SessionCallCopyWithImpl;
@useResult
$Res call({
 String computerId
});




}
/// @nodoc
class _$SessionCallCopyWithImpl<$Res>
    implements $SessionCallCopyWith<$Res> {
  _$SessionCallCopyWithImpl(this._self, this._then);

  final SessionCall _self;
  final $Res Function(SessionCall) _then;

/// Create a copy of SessionCall
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? computerId = null,}) {
  return _then(_self.copyWith(
computerId: null == computerId ? _self.computerId : computerId // ignore: cast_nullable_to_non_nullable
as String,
  ));
}

}


/// Adds pattern-matching-related methods to [SessionCall].
extension SessionCallPatterns on SessionCall {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( SessionCall_Connect value)?  connect,TResult Function( SessionCall_Invoke value)?  invoke,TResult Function( SessionCall_HostInfo value)?  hostInfo,TResult Function( SessionCall_SetOrchestratorVisible value)?  setOrchestratorVisible,required TResult orElse(),}){
final _that = this;
switch (_that) {
case SessionCall_Connect() when connect != null:
return connect(_that);case SessionCall_Invoke() when invoke != null:
return invoke(_that);case SessionCall_HostInfo() when hostInfo != null:
return hostInfo(_that);case SessionCall_SetOrchestratorVisible() when setOrchestratorVisible != null:
return setOrchestratorVisible(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( SessionCall_Connect value)  connect,required TResult Function( SessionCall_Invoke value)  invoke,required TResult Function( SessionCall_HostInfo value)  hostInfo,required TResult Function( SessionCall_SetOrchestratorVisible value)  setOrchestratorVisible,}){
final _that = this;
switch (_that) {
case SessionCall_Connect():
return connect(_that);case SessionCall_Invoke():
return invoke(_that);case SessionCall_HostInfo():
return hostInfo(_that);case SessionCall_SetOrchestratorVisible():
return setOrchestratorVisible(_that);}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( SessionCall_Connect value)?  connect,TResult? Function( SessionCall_Invoke value)?  invoke,TResult? Function( SessionCall_HostInfo value)?  hostInfo,TResult? Function( SessionCall_SetOrchestratorVisible value)?  setOrchestratorVisible,}){
final _that = this;
switch (_that) {
case SessionCall_Connect() when connect != null:
return connect(_that);case SessionCall_Invoke() when invoke != null:
return invoke(_that);case SessionCall_HostInfo() when hostInfo != null:
return hostInfo(_that);case SessionCall_SetOrchestratorVisible() when setOrchestratorVisible != null:
return setOrchestratorVisible(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( String computerId,  bool? allowPairing,  bool? visible)?  connect,TResult Function( String computerId,  String channel,  String argsJson,  String? surface,  int? timeoutMs)?  invoke,TResult Function( String computerId)?  hostInfo,TResult Function( String computerId,  bool visible)?  setOrchestratorVisible,required TResult orElse(),}) {final _that = this;
switch (_that) {
case SessionCall_Connect() when connect != null:
return connect(_that.computerId,_that.allowPairing,_that.visible);case SessionCall_Invoke() when invoke != null:
return invoke(_that.computerId,_that.channel,_that.argsJson,_that.surface,_that.timeoutMs);case SessionCall_HostInfo() when hostInfo != null:
return hostInfo(_that.computerId);case SessionCall_SetOrchestratorVisible() when setOrchestratorVisible != null:
return setOrchestratorVisible(_that.computerId,_that.visible);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( String computerId,  bool? allowPairing,  bool? visible)  connect,required TResult Function( String computerId,  String channel,  String argsJson,  String? surface,  int? timeoutMs)  invoke,required TResult Function( String computerId)  hostInfo,required TResult Function( String computerId,  bool visible)  setOrchestratorVisible,}) {final _that = this;
switch (_that) {
case SessionCall_Connect():
return connect(_that.computerId,_that.allowPairing,_that.visible);case SessionCall_Invoke():
return invoke(_that.computerId,_that.channel,_that.argsJson,_that.surface,_that.timeoutMs);case SessionCall_HostInfo():
return hostInfo(_that.computerId);case SessionCall_SetOrchestratorVisible():
return setOrchestratorVisible(_that.computerId,_that.visible);}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( String computerId,  bool? allowPairing,  bool? visible)?  connect,TResult? Function( String computerId,  String channel,  String argsJson,  String? surface,  int? timeoutMs)?  invoke,TResult? Function( String computerId)?  hostInfo,TResult? Function( String computerId,  bool visible)?  setOrchestratorVisible,}) {final _that = this;
switch (_that) {
case SessionCall_Connect() when connect != null:
return connect(_that.computerId,_that.allowPairing,_that.visible);case SessionCall_Invoke() when invoke != null:
return invoke(_that.computerId,_that.channel,_that.argsJson,_that.surface,_that.timeoutMs);case SessionCall_HostInfo() when hostInfo != null:
return hostInfo(_that.computerId);case SessionCall_SetOrchestratorVisible() when setOrchestratorVisible != null:
return setOrchestratorVisible(_that.computerId,_that.visible);case _:
  return null;

}
}

}

/// @nodoc


class SessionCall_Connect extends SessionCall {
  const SessionCall_Connect({required this.computerId, this.allowPairing, this.visible}): super._();
  

@override final  String computerId;
 final  bool? allowPairing;
 final  bool? visible;

/// Create a copy of SessionCall
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$SessionCall_ConnectCopyWith<SessionCall_Connect> get copyWith => _$SessionCall_ConnectCopyWithImpl<SessionCall_Connect>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SessionCall_Connect&&(identical(other.computerId, computerId) || other.computerId == computerId)&&(identical(other.allowPairing, allowPairing) || other.allowPairing == allowPairing)&&(identical(other.visible, visible) || other.visible == visible));
}


@override
int get hashCode => Object.hash(runtimeType,computerId,allowPairing,visible);

@override
String toString() {
  return 'SessionCall.connect(computerId: $computerId, allowPairing: $allowPairing, visible: $visible)';
}


}

/// @nodoc
abstract mixin class $SessionCall_ConnectCopyWith<$Res> implements $SessionCallCopyWith<$Res> {
  factory $SessionCall_ConnectCopyWith(SessionCall_Connect value, $Res Function(SessionCall_Connect) _then) = _$SessionCall_ConnectCopyWithImpl;
@override @useResult
$Res call({
 String computerId, bool? allowPairing, bool? visible
});




}
/// @nodoc
class _$SessionCall_ConnectCopyWithImpl<$Res>
    implements $SessionCall_ConnectCopyWith<$Res> {
  _$SessionCall_ConnectCopyWithImpl(this._self, this._then);

  final SessionCall_Connect _self;
  final $Res Function(SessionCall_Connect) _then;

/// Create a copy of SessionCall
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? computerId = null,Object? allowPairing = freezed,Object? visible = freezed,}) {
  return _then(SessionCall_Connect(
computerId: null == computerId ? _self.computerId : computerId // ignore: cast_nullable_to_non_nullable
as String,allowPairing: freezed == allowPairing ? _self.allowPairing : allowPairing // ignore: cast_nullable_to_non_nullable
as bool?,visible: freezed == visible ? _self.visible : visible // ignore: cast_nullable_to_non_nullable
as bool?,
  ));
}


}

/// @nodoc


class SessionCall_Invoke extends SessionCall {
  const SessionCall_Invoke({required this.computerId, required this.channel, required this.argsJson, this.surface, this.timeoutMs}): super._();
  

@override final  String computerId;
 final  String channel;
 final  String argsJson;
 final  String? surface;
 final  int? timeoutMs;

/// Create a copy of SessionCall
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$SessionCall_InvokeCopyWith<SessionCall_Invoke> get copyWith => _$SessionCall_InvokeCopyWithImpl<SessionCall_Invoke>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SessionCall_Invoke&&(identical(other.computerId, computerId) || other.computerId == computerId)&&(identical(other.channel, channel) || other.channel == channel)&&(identical(other.argsJson, argsJson) || other.argsJson == argsJson)&&(identical(other.surface, surface) || other.surface == surface)&&(identical(other.timeoutMs, timeoutMs) || other.timeoutMs == timeoutMs));
}


@override
int get hashCode => Object.hash(runtimeType,computerId,channel,argsJson,surface,timeoutMs);

@override
String toString() {
  return 'SessionCall.invoke(computerId: $computerId, channel: $channel, argsJson: $argsJson, surface: $surface, timeoutMs: $timeoutMs)';
}


}

/// @nodoc
abstract mixin class $SessionCall_InvokeCopyWith<$Res> implements $SessionCallCopyWith<$Res> {
  factory $SessionCall_InvokeCopyWith(SessionCall_Invoke value, $Res Function(SessionCall_Invoke) _then) = _$SessionCall_InvokeCopyWithImpl;
@override @useResult
$Res call({
 String computerId, String channel, String argsJson, String? surface, int? timeoutMs
});




}
/// @nodoc
class _$SessionCall_InvokeCopyWithImpl<$Res>
    implements $SessionCall_InvokeCopyWith<$Res> {
  _$SessionCall_InvokeCopyWithImpl(this._self, this._then);

  final SessionCall_Invoke _self;
  final $Res Function(SessionCall_Invoke) _then;

/// Create a copy of SessionCall
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? computerId = null,Object? channel = null,Object? argsJson = null,Object? surface = freezed,Object? timeoutMs = freezed,}) {
  return _then(SessionCall_Invoke(
computerId: null == computerId ? _self.computerId : computerId // ignore: cast_nullable_to_non_nullable
as String,channel: null == channel ? _self.channel : channel // ignore: cast_nullable_to_non_nullable
as String,argsJson: null == argsJson ? _self.argsJson : argsJson // ignore: cast_nullable_to_non_nullable
as String,surface: freezed == surface ? _self.surface : surface // ignore: cast_nullable_to_non_nullable
as String?,timeoutMs: freezed == timeoutMs ? _self.timeoutMs : timeoutMs // ignore: cast_nullable_to_non_nullable
as int?,
  ));
}


}

/// @nodoc


class SessionCall_HostInfo extends SessionCall {
  const SessionCall_HostInfo({required this.computerId}): super._();
  

@override final  String computerId;

/// Create a copy of SessionCall
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$SessionCall_HostInfoCopyWith<SessionCall_HostInfo> get copyWith => _$SessionCall_HostInfoCopyWithImpl<SessionCall_HostInfo>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SessionCall_HostInfo&&(identical(other.computerId, computerId) || other.computerId == computerId));
}


@override
int get hashCode => Object.hash(runtimeType,computerId);

@override
String toString() {
  return 'SessionCall.hostInfo(computerId: $computerId)';
}


}

/// @nodoc
abstract mixin class $SessionCall_HostInfoCopyWith<$Res> implements $SessionCallCopyWith<$Res> {
  factory $SessionCall_HostInfoCopyWith(SessionCall_HostInfo value, $Res Function(SessionCall_HostInfo) _then) = _$SessionCall_HostInfoCopyWithImpl;
@override @useResult
$Res call({
 String computerId
});




}
/// @nodoc
class _$SessionCall_HostInfoCopyWithImpl<$Res>
    implements $SessionCall_HostInfoCopyWith<$Res> {
  _$SessionCall_HostInfoCopyWithImpl(this._self, this._then);

  final SessionCall_HostInfo _self;
  final $Res Function(SessionCall_HostInfo) _then;

/// Create a copy of SessionCall
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? computerId = null,}) {
  return _then(SessionCall_HostInfo(
computerId: null == computerId ? _self.computerId : computerId // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class SessionCall_SetOrchestratorVisible extends SessionCall {
  const SessionCall_SetOrchestratorVisible({required this.computerId, required this.visible}): super._();
  

@override final  String computerId;
 final  bool visible;

/// Create a copy of SessionCall
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$SessionCall_SetOrchestratorVisibleCopyWith<SessionCall_SetOrchestratorVisible> get copyWith => _$SessionCall_SetOrchestratorVisibleCopyWithImpl<SessionCall_SetOrchestratorVisible>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SessionCall_SetOrchestratorVisible&&(identical(other.computerId, computerId) || other.computerId == computerId)&&(identical(other.visible, visible) || other.visible == visible));
}


@override
int get hashCode => Object.hash(runtimeType,computerId,visible);

@override
String toString() {
  return 'SessionCall.setOrchestratorVisible(computerId: $computerId, visible: $visible)';
}


}

/// @nodoc
abstract mixin class $SessionCall_SetOrchestratorVisibleCopyWith<$Res> implements $SessionCallCopyWith<$Res> {
  factory $SessionCall_SetOrchestratorVisibleCopyWith(SessionCall_SetOrchestratorVisible value, $Res Function(SessionCall_SetOrchestratorVisible) _then) = _$SessionCall_SetOrchestratorVisibleCopyWithImpl;
@override @useResult
$Res call({
 String computerId, bool visible
});




}
/// @nodoc
class _$SessionCall_SetOrchestratorVisibleCopyWithImpl<$Res>
    implements $SessionCall_SetOrchestratorVisibleCopyWith<$Res> {
  _$SessionCall_SetOrchestratorVisibleCopyWithImpl(this._self, this._then);

  final SessionCall_SetOrchestratorVisible _self;
  final $Res Function(SessionCall_SetOrchestratorVisible) _then;

/// Create a copy of SessionCall
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? computerId = null,Object? visible = null,}) {
  return _then(SessionCall_SetOrchestratorVisible(
computerId: null == computerId ? _self.computerId : computerId // ignore: cast_nullable_to_non_nullable
as String,visible: null == visible ? _self.visible : visible // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

// dart format on
