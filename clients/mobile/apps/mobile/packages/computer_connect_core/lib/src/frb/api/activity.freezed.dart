// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'activity.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;
/// @nodoc
mixin _$ActivityIntent {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ActivityIntent);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'ActivityIntent()';
}


}

/// @nodoc
class $ActivityIntentCopyWith<$Res>  {
$ActivityIntentCopyWith(ActivityIntent _, $Res Function(ActivityIntent) __);
}


/// Adds pattern-matching-related methods to [ActivityIntent].
extension ActivityIntentPatterns on ActivityIntent {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( ActivityIntent_SetConnected value)?  setConnected,TResult Function( ActivityIntent_Watch value)?  watch,TResult Function( ActivityIntent_Release value)?  release,TResult Function( ActivityIntent_Load value)?  load,TResult Function( ActivityIntent_SetHookPaused value)?  setHookPaused,TResult Function( ActivityIntent_RunPr value)?  runPr,TResult Function( ActivityIntent_WatchDiff value)?  watchDiff,TResult Function( ActivityIntent_ReleaseDiff value)?  releaseDiff,TResult Function( ActivityIntent_RefreshDiff value)?  refreshDiff,TResult Function( ActivityIntent_Close value)?  close,required TResult orElse(),}){
final _that = this;
switch (_that) {
case ActivityIntent_SetConnected() when setConnected != null:
return setConnected(_that);case ActivityIntent_Watch() when watch != null:
return watch(_that);case ActivityIntent_Release() when release != null:
return release(_that);case ActivityIntent_Load() when load != null:
return load(_that);case ActivityIntent_SetHookPaused() when setHookPaused != null:
return setHookPaused(_that);case ActivityIntent_RunPr() when runPr != null:
return runPr(_that);case ActivityIntent_WatchDiff() when watchDiff != null:
return watchDiff(_that);case ActivityIntent_ReleaseDiff() when releaseDiff != null:
return releaseDiff(_that);case ActivityIntent_RefreshDiff() when refreshDiff != null:
return refreshDiff(_that);case ActivityIntent_Close() when close != null:
return close(_that);case _:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( ActivityIntent_SetConnected value)  setConnected,required TResult Function( ActivityIntent_Watch value)  watch,required TResult Function( ActivityIntent_Release value)  release,required TResult Function( ActivityIntent_Load value)  load,required TResult Function( ActivityIntent_SetHookPaused value)  setHookPaused,required TResult Function( ActivityIntent_RunPr value)  runPr,required TResult Function( ActivityIntent_WatchDiff value)  watchDiff,required TResult Function( ActivityIntent_ReleaseDiff value)  releaseDiff,required TResult Function( ActivityIntent_RefreshDiff value)  refreshDiff,required TResult Function( ActivityIntent_Close value)  close,}){
final _that = this;
switch (_that) {
case ActivityIntent_SetConnected():
return setConnected(_that);case ActivityIntent_Watch():
return watch(_that);case ActivityIntent_Release():
return release(_that);case ActivityIntent_Load():
return load(_that);case ActivityIntent_SetHookPaused():
return setHookPaused(_that);case ActivityIntent_RunPr():
return runPr(_that);case ActivityIntent_WatchDiff():
return watchDiff(_that);case ActivityIntent_ReleaseDiff():
return releaseDiff(_that);case ActivityIntent_RefreshDiff():
return refreshDiff(_that);case ActivityIntent_Close():
return close(_that);}
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( ActivityIntent_SetConnected value)?  setConnected,TResult? Function( ActivityIntent_Watch value)?  watch,TResult? Function( ActivityIntent_Release value)?  release,TResult? Function( ActivityIntent_Load value)?  load,TResult? Function( ActivityIntent_SetHookPaused value)?  setHookPaused,TResult? Function( ActivityIntent_RunPr value)?  runPr,TResult? Function( ActivityIntent_WatchDiff value)?  watchDiff,TResult? Function( ActivityIntent_ReleaseDiff value)?  releaseDiff,TResult? Function( ActivityIntent_RefreshDiff value)?  refreshDiff,TResult? Function( ActivityIntent_Close value)?  close,}){
final _that = this;
switch (_that) {
case ActivityIntent_SetConnected() when setConnected != null:
return setConnected(_that);case ActivityIntent_Watch() when watch != null:
return watch(_that);case ActivityIntent_Release() when release != null:
return release(_that);case ActivityIntent_Load() when load != null:
return load(_that);case ActivityIntent_SetHookPaused() when setHookPaused != null:
return setHookPaused(_that);case ActivityIntent_RunPr() when runPr != null:
return runPr(_that);case ActivityIntent_WatchDiff() when watchDiff != null:
return watchDiff(_that);case ActivityIntent_ReleaseDiff() when releaseDiff != null:
return releaseDiff(_that);case ActivityIntent_RefreshDiff() when refreshDiff != null:
return refreshDiff(_that);case ActivityIntent_Close() when close != null:
return close(_that);case _:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( bool connected)?  setConnected,TResult Function( ChatRefView chat,  int token)?  watch,TResult Function( int token)?  release,TResult Function( ChatRefView chat)?  load,TResult Function( ChatRefView chat,  String hookKey,  bool paused)?  setHookPaused,TResult Function( ChatRefView chat,  PrActionKind action,  String? repoId,  PrIdentityView? identity,  bool confirmUnresolvedComments)?  runPr,TResult Function( DiffTargetView target,  int token)?  watchDiff,TResult Function( int token)?  releaseDiff,TResult Function( DiffTargetView target)?  refreshDiff,TResult Function()?  close,required TResult orElse(),}) {final _that = this;
switch (_that) {
case ActivityIntent_SetConnected() when setConnected != null:
return setConnected(_that.connected);case ActivityIntent_Watch() when watch != null:
return watch(_that.chat,_that.token);case ActivityIntent_Release() when release != null:
return release(_that.token);case ActivityIntent_Load() when load != null:
return load(_that.chat);case ActivityIntent_SetHookPaused() when setHookPaused != null:
return setHookPaused(_that.chat,_that.hookKey,_that.paused);case ActivityIntent_RunPr() when runPr != null:
return runPr(_that.chat,_that.action,_that.repoId,_that.identity,_that.confirmUnresolvedComments);case ActivityIntent_WatchDiff() when watchDiff != null:
return watchDiff(_that.target,_that.token);case ActivityIntent_ReleaseDiff() when releaseDiff != null:
return releaseDiff(_that.token);case ActivityIntent_RefreshDiff() when refreshDiff != null:
return refreshDiff(_that.target);case ActivityIntent_Close() when close != null:
return close();case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( bool connected)  setConnected,required TResult Function( ChatRefView chat,  int token)  watch,required TResult Function( int token)  release,required TResult Function( ChatRefView chat)  load,required TResult Function( ChatRefView chat,  String hookKey,  bool paused)  setHookPaused,required TResult Function( ChatRefView chat,  PrActionKind action,  String? repoId,  PrIdentityView? identity,  bool confirmUnresolvedComments)  runPr,required TResult Function( DiffTargetView target,  int token)  watchDiff,required TResult Function( int token)  releaseDiff,required TResult Function( DiffTargetView target)  refreshDiff,required TResult Function()  close,}) {final _that = this;
switch (_that) {
case ActivityIntent_SetConnected():
return setConnected(_that.connected);case ActivityIntent_Watch():
return watch(_that.chat,_that.token);case ActivityIntent_Release():
return release(_that.token);case ActivityIntent_Load():
return load(_that.chat);case ActivityIntent_SetHookPaused():
return setHookPaused(_that.chat,_that.hookKey,_that.paused);case ActivityIntent_RunPr():
return runPr(_that.chat,_that.action,_that.repoId,_that.identity,_that.confirmUnresolvedComments);case ActivityIntent_WatchDiff():
return watchDiff(_that.target,_that.token);case ActivityIntent_ReleaseDiff():
return releaseDiff(_that.token);case ActivityIntent_RefreshDiff():
return refreshDiff(_that.target);case ActivityIntent_Close():
return close();}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( bool connected)?  setConnected,TResult? Function( ChatRefView chat,  int token)?  watch,TResult? Function( int token)?  release,TResult? Function( ChatRefView chat)?  load,TResult? Function( ChatRefView chat,  String hookKey,  bool paused)?  setHookPaused,TResult? Function( ChatRefView chat,  PrActionKind action,  String? repoId,  PrIdentityView? identity,  bool confirmUnresolvedComments)?  runPr,TResult? Function( DiffTargetView target,  int token)?  watchDiff,TResult? Function( int token)?  releaseDiff,TResult? Function( DiffTargetView target)?  refreshDiff,TResult? Function()?  close,}) {final _that = this;
switch (_that) {
case ActivityIntent_SetConnected() when setConnected != null:
return setConnected(_that.connected);case ActivityIntent_Watch() when watch != null:
return watch(_that.chat,_that.token);case ActivityIntent_Release() when release != null:
return release(_that.token);case ActivityIntent_Load() when load != null:
return load(_that.chat);case ActivityIntent_SetHookPaused() when setHookPaused != null:
return setHookPaused(_that.chat,_that.hookKey,_that.paused);case ActivityIntent_RunPr() when runPr != null:
return runPr(_that.chat,_that.action,_that.repoId,_that.identity,_that.confirmUnresolvedComments);case ActivityIntent_WatchDiff() when watchDiff != null:
return watchDiff(_that.target,_that.token);case ActivityIntent_ReleaseDiff() when releaseDiff != null:
return releaseDiff(_that.token);case ActivityIntent_RefreshDiff() when refreshDiff != null:
return refreshDiff(_that.target);case ActivityIntent_Close() when close != null:
return close();case _:
  return null;

}
}

}

/// @nodoc


class ActivityIntent_SetConnected extends ActivityIntent {
  const ActivityIntent_SetConnected({required this.connected}): super._();
  

 final  bool connected;

/// Create a copy of ActivityIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ActivityIntent_SetConnectedCopyWith<ActivityIntent_SetConnected> get copyWith => _$ActivityIntent_SetConnectedCopyWithImpl<ActivityIntent_SetConnected>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ActivityIntent_SetConnected&&(identical(other.connected, connected) || other.connected == connected));
}


@override
int get hashCode => Object.hash(runtimeType,connected);

@override
String toString() {
  return 'ActivityIntent.setConnected(connected: $connected)';
}


}

/// @nodoc
abstract mixin class $ActivityIntent_SetConnectedCopyWith<$Res> implements $ActivityIntentCopyWith<$Res> {
  factory $ActivityIntent_SetConnectedCopyWith(ActivityIntent_SetConnected value, $Res Function(ActivityIntent_SetConnected) _then) = _$ActivityIntent_SetConnectedCopyWithImpl;
@useResult
$Res call({
 bool connected
});




}
/// @nodoc
class _$ActivityIntent_SetConnectedCopyWithImpl<$Res>
    implements $ActivityIntent_SetConnectedCopyWith<$Res> {
  _$ActivityIntent_SetConnectedCopyWithImpl(this._self, this._then);

  final ActivityIntent_SetConnected _self;
  final $Res Function(ActivityIntent_SetConnected) _then;

/// Create a copy of ActivityIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? connected = null,}) {
  return _then(ActivityIntent_SetConnected(
connected: null == connected ? _self.connected : connected // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class ActivityIntent_Watch extends ActivityIntent {
  const ActivityIntent_Watch({required this.chat, required this.token}): super._();
  

 final  ChatRefView chat;
 final  int token;

/// Create a copy of ActivityIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ActivityIntent_WatchCopyWith<ActivityIntent_Watch> get copyWith => _$ActivityIntent_WatchCopyWithImpl<ActivityIntent_Watch>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ActivityIntent_Watch&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.token, token) || other.token == token));
}


@override
int get hashCode => Object.hash(runtimeType,chat,token);

@override
String toString() {
  return 'ActivityIntent.watch(chat: $chat, token: $token)';
}


}

/// @nodoc
abstract mixin class $ActivityIntent_WatchCopyWith<$Res> implements $ActivityIntentCopyWith<$Res> {
  factory $ActivityIntent_WatchCopyWith(ActivityIntent_Watch value, $Res Function(ActivityIntent_Watch) _then) = _$ActivityIntent_WatchCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, int token
});




}
/// @nodoc
class _$ActivityIntent_WatchCopyWithImpl<$Res>
    implements $ActivityIntent_WatchCopyWith<$Res> {
  _$ActivityIntent_WatchCopyWithImpl(this._self, this._then);

  final ActivityIntent_Watch _self;
  final $Res Function(ActivityIntent_Watch) _then;

/// Create a copy of ActivityIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? token = null,}) {
  return _then(ActivityIntent_Watch(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,token: null == token ? _self.token : token // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}

/// @nodoc


class ActivityIntent_Release extends ActivityIntent {
  const ActivityIntent_Release({required this.token}): super._();
  

 final  int token;

/// Create a copy of ActivityIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ActivityIntent_ReleaseCopyWith<ActivityIntent_Release> get copyWith => _$ActivityIntent_ReleaseCopyWithImpl<ActivityIntent_Release>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ActivityIntent_Release&&(identical(other.token, token) || other.token == token));
}


@override
int get hashCode => Object.hash(runtimeType,token);

@override
String toString() {
  return 'ActivityIntent.release(token: $token)';
}


}

/// @nodoc
abstract mixin class $ActivityIntent_ReleaseCopyWith<$Res> implements $ActivityIntentCopyWith<$Res> {
  factory $ActivityIntent_ReleaseCopyWith(ActivityIntent_Release value, $Res Function(ActivityIntent_Release) _then) = _$ActivityIntent_ReleaseCopyWithImpl;
@useResult
$Res call({
 int token
});




}
/// @nodoc
class _$ActivityIntent_ReleaseCopyWithImpl<$Res>
    implements $ActivityIntent_ReleaseCopyWith<$Res> {
  _$ActivityIntent_ReleaseCopyWithImpl(this._self, this._then);

  final ActivityIntent_Release _self;
  final $Res Function(ActivityIntent_Release) _then;

/// Create a copy of ActivityIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? token = null,}) {
  return _then(ActivityIntent_Release(
token: null == token ? _self.token : token // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}

/// @nodoc


class ActivityIntent_Load extends ActivityIntent {
  const ActivityIntent_Load({required this.chat}): super._();
  

 final  ChatRefView chat;

/// Create a copy of ActivityIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ActivityIntent_LoadCopyWith<ActivityIntent_Load> get copyWith => _$ActivityIntent_LoadCopyWithImpl<ActivityIntent_Load>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ActivityIntent_Load&&(identical(other.chat, chat) || other.chat == chat));
}


@override
int get hashCode => Object.hash(runtimeType,chat);

@override
String toString() {
  return 'ActivityIntent.load(chat: $chat)';
}


}

/// @nodoc
abstract mixin class $ActivityIntent_LoadCopyWith<$Res> implements $ActivityIntentCopyWith<$Res> {
  factory $ActivityIntent_LoadCopyWith(ActivityIntent_Load value, $Res Function(ActivityIntent_Load) _then) = _$ActivityIntent_LoadCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat
});




}
/// @nodoc
class _$ActivityIntent_LoadCopyWithImpl<$Res>
    implements $ActivityIntent_LoadCopyWith<$Res> {
  _$ActivityIntent_LoadCopyWithImpl(this._self, this._then);

  final ActivityIntent_Load _self;
  final $Res Function(ActivityIntent_Load) _then;

/// Create a copy of ActivityIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,}) {
  return _then(ActivityIntent_Load(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,
  ));
}


}

/// @nodoc


class ActivityIntent_SetHookPaused extends ActivityIntent {
  const ActivityIntent_SetHookPaused({required this.chat, required this.hookKey, required this.paused}): super._();
  

 final  ChatRefView chat;
 final  String hookKey;
 final  bool paused;

/// Create a copy of ActivityIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ActivityIntent_SetHookPausedCopyWith<ActivityIntent_SetHookPaused> get copyWith => _$ActivityIntent_SetHookPausedCopyWithImpl<ActivityIntent_SetHookPaused>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ActivityIntent_SetHookPaused&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.hookKey, hookKey) || other.hookKey == hookKey)&&(identical(other.paused, paused) || other.paused == paused));
}


@override
int get hashCode => Object.hash(runtimeType,chat,hookKey,paused);

@override
String toString() {
  return 'ActivityIntent.setHookPaused(chat: $chat, hookKey: $hookKey, paused: $paused)';
}


}

/// @nodoc
abstract mixin class $ActivityIntent_SetHookPausedCopyWith<$Res> implements $ActivityIntentCopyWith<$Res> {
  factory $ActivityIntent_SetHookPausedCopyWith(ActivityIntent_SetHookPaused value, $Res Function(ActivityIntent_SetHookPaused) _then) = _$ActivityIntent_SetHookPausedCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, String hookKey, bool paused
});




}
/// @nodoc
class _$ActivityIntent_SetHookPausedCopyWithImpl<$Res>
    implements $ActivityIntent_SetHookPausedCopyWith<$Res> {
  _$ActivityIntent_SetHookPausedCopyWithImpl(this._self, this._then);

  final ActivityIntent_SetHookPaused _self;
  final $Res Function(ActivityIntent_SetHookPaused) _then;

/// Create a copy of ActivityIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? hookKey = null,Object? paused = null,}) {
  return _then(ActivityIntent_SetHookPaused(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,hookKey: null == hookKey ? _self.hookKey : hookKey // ignore: cast_nullable_to_non_nullable
as String,paused: null == paused ? _self.paused : paused // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class ActivityIntent_RunPr extends ActivityIntent {
  const ActivityIntent_RunPr({required this.chat, required this.action, this.repoId, this.identity, required this.confirmUnresolvedComments}): super._();
  

 final  ChatRefView chat;
 final  PrActionKind action;
 final  String? repoId;
 final  PrIdentityView? identity;
 final  bool confirmUnresolvedComments;

/// Create a copy of ActivityIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ActivityIntent_RunPrCopyWith<ActivityIntent_RunPr> get copyWith => _$ActivityIntent_RunPrCopyWithImpl<ActivityIntent_RunPr>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ActivityIntent_RunPr&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.action, action) || other.action == action)&&(identical(other.repoId, repoId) || other.repoId == repoId)&&(identical(other.identity, identity) || other.identity == identity)&&(identical(other.confirmUnresolvedComments, confirmUnresolvedComments) || other.confirmUnresolvedComments == confirmUnresolvedComments));
}


@override
int get hashCode => Object.hash(runtimeType,chat,action,repoId,identity,confirmUnresolvedComments);

@override
String toString() {
  return 'ActivityIntent.runPr(chat: $chat, action: $action, repoId: $repoId, identity: $identity, confirmUnresolvedComments: $confirmUnresolvedComments)';
}


}

/// @nodoc
abstract mixin class $ActivityIntent_RunPrCopyWith<$Res> implements $ActivityIntentCopyWith<$Res> {
  factory $ActivityIntent_RunPrCopyWith(ActivityIntent_RunPr value, $Res Function(ActivityIntent_RunPr) _then) = _$ActivityIntent_RunPrCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, PrActionKind action, String? repoId, PrIdentityView? identity, bool confirmUnresolvedComments
});




}
/// @nodoc
class _$ActivityIntent_RunPrCopyWithImpl<$Res>
    implements $ActivityIntent_RunPrCopyWith<$Res> {
  _$ActivityIntent_RunPrCopyWithImpl(this._self, this._then);

  final ActivityIntent_RunPr _self;
  final $Res Function(ActivityIntent_RunPr) _then;

/// Create a copy of ActivityIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? action = null,Object? repoId = freezed,Object? identity = freezed,Object? confirmUnresolvedComments = null,}) {
  return _then(ActivityIntent_RunPr(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,action: null == action ? _self.action : action // ignore: cast_nullable_to_non_nullable
as PrActionKind,repoId: freezed == repoId ? _self.repoId : repoId // ignore: cast_nullable_to_non_nullable
as String?,identity: freezed == identity ? _self.identity : identity // ignore: cast_nullable_to_non_nullable
as PrIdentityView?,confirmUnresolvedComments: null == confirmUnresolvedComments ? _self.confirmUnresolvedComments : confirmUnresolvedComments // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class ActivityIntent_WatchDiff extends ActivityIntent {
  const ActivityIntent_WatchDiff({required this.target, required this.token}): super._();
  

 final  DiffTargetView target;
 final  int token;

/// Create a copy of ActivityIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ActivityIntent_WatchDiffCopyWith<ActivityIntent_WatchDiff> get copyWith => _$ActivityIntent_WatchDiffCopyWithImpl<ActivityIntent_WatchDiff>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ActivityIntent_WatchDiff&&(identical(other.target, target) || other.target == target)&&(identical(other.token, token) || other.token == token));
}


@override
int get hashCode => Object.hash(runtimeType,target,token);

@override
String toString() {
  return 'ActivityIntent.watchDiff(target: $target, token: $token)';
}


}

/// @nodoc
abstract mixin class $ActivityIntent_WatchDiffCopyWith<$Res> implements $ActivityIntentCopyWith<$Res> {
  factory $ActivityIntent_WatchDiffCopyWith(ActivityIntent_WatchDiff value, $Res Function(ActivityIntent_WatchDiff) _then) = _$ActivityIntent_WatchDiffCopyWithImpl;
@useResult
$Res call({
 DiffTargetView target, int token
});




}
/// @nodoc
class _$ActivityIntent_WatchDiffCopyWithImpl<$Res>
    implements $ActivityIntent_WatchDiffCopyWith<$Res> {
  _$ActivityIntent_WatchDiffCopyWithImpl(this._self, this._then);

  final ActivityIntent_WatchDiff _self;
  final $Res Function(ActivityIntent_WatchDiff) _then;

/// Create a copy of ActivityIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? target = null,Object? token = null,}) {
  return _then(ActivityIntent_WatchDiff(
target: null == target ? _self.target : target // ignore: cast_nullable_to_non_nullable
as DiffTargetView,token: null == token ? _self.token : token // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}

/// @nodoc


class ActivityIntent_ReleaseDiff extends ActivityIntent {
  const ActivityIntent_ReleaseDiff({required this.token}): super._();
  

 final  int token;

/// Create a copy of ActivityIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ActivityIntent_ReleaseDiffCopyWith<ActivityIntent_ReleaseDiff> get copyWith => _$ActivityIntent_ReleaseDiffCopyWithImpl<ActivityIntent_ReleaseDiff>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ActivityIntent_ReleaseDiff&&(identical(other.token, token) || other.token == token));
}


@override
int get hashCode => Object.hash(runtimeType,token);

@override
String toString() {
  return 'ActivityIntent.releaseDiff(token: $token)';
}


}

/// @nodoc
abstract mixin class $ActivityIntent_ReleaseDiffCopyWith<$Res> implements $ActivityIntentCopyWith<$Res> {
  factory $ActivityIntent_ReleaseDiffCopyWith(ActivityIntent_ReleaseDiff value, $Res Function(ActivityIntent_ReleaseDiff) _then) = _$ActivityIntent_ReleaseDiffCopyWithImpl;
@useResult
$Res call({
 int token
});




}
/// @nodoc
class _$ActivityIntent_ReleaseDiffCopyWithImpl<$Res>
    implements $ActivityIntent_ReleaseDiffCopyWith<$Res> {
  _$ActivityIntent_ReleaseDiffCopyWithImpl(this._self, this._then);

  final ActivityIntent_ReleaseDiff _self;
  final $Res Function(ActivityIntent_ReleaseDiff) _then;

/// Create a copy of ActivityIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? token = null,}) {
  return _then(ActivityIntent_ReleaseDiff(
token: null == token ? _self.token : token // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}

/// @nodoc


class ActivityIntent_RefreshDiff extends ActivityIntent {
  const ActivityIntent_RefreshDiff({required this.target}): super._();
  

 final  DiffTargetView target;

/// Create a copy of ActivityIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ActivityIntent_RefreshDiffCopyWith<ActivityIntent_RefreshDiff> get copyWith => _$ActivityIntent_RefreshDiffCopyWithImpl<ActivityIntent_RefreshDiff>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ActivityIntent_RefreshDiff&&(identical(other.target, target) || other.target == target));
}


@override
int get hashCode => Object.hash(runtimeType,target);

@override
String toString() {
  return 'ActivityIntent.refreshDiff(target: $target)';
}


}

/// @nodoc
abstract mixin class $ActivityIntent_RefreshDiffCopyWith<$Res> implements $ActivityIntentCopyWith<$Res> {
  factory $ActivityIntent_RefreshDiffCopyWith(ActivityIntent_RefreshDiff value, $Res Function(ActivityIntent_RefreshDiff) _then) = _$ActivityIntent_RefreshDiffCopyWithImpl;
@useResult
$Res call({
 DiffTargetView target
});




}
/// @nodoc
class _$ActivityIntent_RefreshDiffCopyWithImpl<$Res>
    implements $ActivityIntent_RefreshDiffCopyWith<$Res> {
  _$ActivityIntent_RefreshDiffCopyWithImpl(this._self, this._then);

  final ActivityIntent_RefreshDiff _self;
  final $Res Function(ActivityIntent_RefreshDiff) _then;

/// Create a copy of ActivityIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? target = null,}) {
  return _then(ActivityIntent_RefreshDiff(
target: null == target ? _self.target : target // ignore: cast_nullable_to_non_nullable
as DiffTargetView,
  ));
}


}

/// @nodoc


class ActivityIntent_Close extends ActivityIntent {
  const ActivityIntent_Close(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ActivityIntent_Close);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'ActivityIntent.close()';
}


}




/// @nodoc
mixin _$DiffPhase {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is DiffPhase);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'DiffPhase()';
}


}

/// @nodoc
class $DiffPhaseCopyWith<$Res>  {
$DiffPhaseCopyWith(DiffPhase _, $Res Function(DiffPhase) __);
}


/// Adds pattern-matching-related methods to [DiffPhase].
extension DiffPhasePatterns on DiffPhase {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( DiffPhase_Loading value)?  loading,TResult Function( DiffPhase_Failed value)?  failed,TResult Function( DiffPhase_Shown value)?  shown,required TResult orElse(),}){
final _that = this;
switch (_that) {
case DiffPhase_Loading() when loading != null:
return loading(_that);case DiffPhase_Failed() when failed != null:
return failed(_that);case DiffPhase_Shown() when shown != null:
return shown(_that);case _:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( DiffPhase_Loading value)  loading,required TResult Function( DiffPhase_Failed value)  failed,required TResult Function( DiffPhase_Shown value)  shown,}){
final _that = this;
switch (_that) {
case DiffPhase_Loading():
return loading(_that);case DiffPhase_Failed():
return failed(_that);case DiffPhase_Shown():
return shown(_that);}
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( DiffPhase_Loading value)?  loading,TResult? Function( DiffPhase_Failed value)?  failed,TResult? Function( DiffPhase_Shown value)?  shown,}){
final _that = this;
switch (_that) {
case DiffPhase_Loading() when loading != null:
return loading(_that);case DiffPhase_Failed() when failed != null:
return failed(_that);case DiffPhase_Shown() when shown != null:
return shown(_that);case _:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function()?  loading,TResult Function( String message)?  failed,TResult Function()?  shown,required TResult orElse(),}) {final _that = this;
switch (_that) {
case DiffPhase_Loading() when loading != null:
return loading();case DiffPhase_Failed() when failed != null:
return failed(_that.message);case DiffPhase_Shown() when shown != null:
return shown();case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function()  loading,required TResult Function( String message)  failed,required TResult Function()  shown,}) {final _that = this;
switch (_that) {
case DiffPhase_Loading():
return loading();case DiffPhase_Failed():
return failed(_that.message);case DiffPhase_Shown():
return shown();}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function()?  loading,TResult? Function( String message)?  failed,TResult? Function()?  shown,}) {final _that = this;
switch (_that) {
case DiffPhase_Loading() when loading != null:
return loading();case DiffPhase_Failed() when failed != null:
return failed(_that.message);case DiffPhase_Shown() when shown != null:
return shown();case _:
  return null;

}
}

}

/// @nodoc


class DiffPhase_Loading extends DiffPhase {
  const DiffPhase_Loading(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is DiffPhase_Loading);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'DiffPhase.loading()';
}


}




/// @nodoc


class DiffPhase_Failed extends DiffPhase {
  const DiffPhase_Failed({required this.message}): super._();
  

 final  String message;

/// Create a copy of DiffPhase
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$DiffPhase_FailedCopyWith<DiffPhase_Failed> get copyWith => _$DiffPhase_FailedCopyWithImpl<DiffPhase_Failed>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is DiffPhase_Failed&&(identical(other.message, message) || other.message == message));
}


@override
int get hashCode => Object.hash(runtimeType,message);

@override
String toString() {
  return 'DiffPhase.failed(message: $message)';
}


}

/// @nodoc
abstract mixin class $DiffPhase_FailedCopyWith<$Res> implements $DiffPhaseCopyWith<$Res> {
  factory $DiffPhase_FailedCopyWith(DiffPhase_Failed value, $Res Function(DiffPhase_Failed) _then) = _$DiffPhase_FailedCopyWithImpl;
@useResult
$Res call({
 String message
});




}
/// @nodoc
class _$DiffPhase_FailedCopyWithImpl<$Res>
    implements $DiffPhase_FailedCopyWith<$Res> {
  _$DiffPhase_FailedCopyWithImpl(this._self, this._then);

  final DiffPhase_Failed _self;
  final $Res Function(DiffPhase_Failed) _then;

/// Create a copy of DiffPhase
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? message = null,}) {
  return _then(DiffPhase_Failed(
message: null == message ? _self.message : message // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class DiffPhase_Shown extends DiffPhase {
  const DiffPhase_Shown(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is DiffPhase_Shown);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'DiffPhase.shown()';
}


}




/// @nodoc
mixin _$FilesStatus {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is FilesStatus);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'FilesStatus()';
}


}

/// @nodoc
class $FilesStatusCopyWith<$Res>  {
$FilesStatusCopyWith(FilesStatus _, $Res Function(FilesStatus) __);
}


/// Adds pattern-matching-related methods to [FilesStatus].
extension FilesStatusPatterns on FilesStatus {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( FilesStatus_Loading value)?  loading,TResult Function( FilesStatus_Loaded value)?  loaded,TResult Function( FilesStatus_Failed value)?  failed,required TResult orElse(),}){
final _that = this;
switch (_that) {
case FilesStatus_Loading() when loading != null:
return loading(_that);case FilesStatus_Loaded() when loaded != null:
return loaded(_that);case FilesStatus_Failed() when failed != null:
return failed(_that);case _:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( FilesStatus_Loading value)  loading,required TResult Function( FilesStatus_Loaded value)  loaded,required TResult Function( FilesStatus_Failed value)  failed,}){
final _that = this;
switch (_that) {
case FilesStatus_Loading():
return loading(_that);case FilesStatus_Loaded():
return loaded(_that);case FilesStatus_Failed():
return failed(_that);}
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( FilesStatus_Loading value)?  loading,TResult? Function( FilesStatus_Loaded value)?  loaded,TResult? Function( FilesStatus_Failed value)?  failed,}){
final _that = this;
switch (_that) {
case FilesStatus_Loading() when loading != null:
return loading(_that);case FilesStatus_Loaded() when loaded != null:
return loaded(_that);case FilesStatus_Failed() when failed != null:
return failed(_that);case _:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function()?  loading,TResult Function()?  loaded,TResult Function( String message)?  failed,required TResult orElse(),}) {final _that = this;
switch (_that) {
case FilesStatus_Loading() when loading != null:
return loading();case FilesStatus_Loaded() when loaded != null:
return loaded();case FilesStatus_Failed() when failed != null:
return failed(_that.message);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function()  loading,required TResult Function()  loaded,required TResult Function( String message)  failed,}) {final _that = this;
switch (_that) {
case FilesStatus_Loading():
return loading();case FilesStatus_Loaded():
return loaded();case FilesStatus_Failed():
return failed(_that.message);}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function()?  loading,TResult? Function()?  loaded,TResult? Function( String message)?  failed,}) {final _that = this;
switch (_that) {
case FilesStatus_Loading() when loading != null:
return loading();case FilesStatus_Loaded() when loaded != null:
return loaded();case FilesStatus_Failed() when failed != null:
return failed(_that.message);case _:
  return null;

}
}

}

/// @nodoc


class FilesStatus_Loading extends FilesStatus {
  const FilesStatus_Loading(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is FilesStatus_Loading);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'FilesStatus.loading()';
}


}




/// @nodoc


class FilesStatus_Loaded extends FilesStatus {
  const FilesStatus_Loaded(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is FilesStatus_Loaded);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'FilesStatus.loaded()';
}


}




/// @nodoc


class FilesStatus_Failed extends FilesStatus {
  const FilesStatus_Failed({required this.message}): super._();
  

 final  String message;

/// Create a copy of FilesStatus
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$FilesStatus_FailedCopyWith<FilesStatus_Failed> get copyWith => _$FilesStatus_FailedCopyWithImpl<FilesStatus_Failed>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is FilesStatus_Failed&&(identical(other.message, message) || other.message == message));
}


@override
int get hashCode => Object.hash(runtimeType,message);

@override
String toString() {
  return 'FilesStatus.failed(message: $message)';
}


}

/// @nodoc
abstract mixin class $FilesStatus_FailedCopyWith<$Res> implements $FilesStatusCopyWith<$Res> {
  factory $FilesStatus_FailedCopyWith(FilesStatus_Failed value, $Res Function(FilesStatus_Failed) _then) = _$FilesStatus_FailedCopyWithImpl;
@useResult
$Res call({
 String message
});




}
/// @nodoc
class _$FilesStatus_FailedCopyWithImpl<$Res>
    implements $FilesStatus_FailedCopyWith<$Res> {
  _$FilesStatus_FailedCopyWithImpl(this._self, this._then);

  final FilesStatus_Failed _self;
  final $Res Function(FilesStatus_Failed) _then;

/// Create a copy of FilesStatus
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? message = null,}) {
  return _then(FilesStatus_Failed(
message: null == message ? _self.message : message // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

// dart format on
