// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'orchestrator.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;
/// @nodoc
mixin _$OrchestratorIntent {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorIntent);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'OrchestratorIntent()';
}


}

/// @nodoc
class $OrchestratorIntentCopyWith<$Res>  {
$OrchestratorIntentCopyWith(OrchestratorIntent _, $Res Function(OrchestratorIntent) __);
}


/// Adds pattern-matching-related methods to [OrchestratorIntent].
extension OrchestratorIntentPatterns on OrchestratorIntent {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( OrchestratorIntent_SetOnline value)?  setOnline,TResult Function( OrchestratorIntent_SetVisible value)?  setVisible,TResult Function( OrchestratorIntent_ReadCatalog value)?  readCatalog,TResult Function( OrchestratorIntent_CatalogShown value)?  catalogShown,TResult Function( OrchestratorIntent_WatchEntries value)?  watchEntries,TResult Function( OrchestratorIntent_Enter value)?  enter,TResult Function( OrchestratorIntent_Entered value)?  entered,TResult Function( OrchestratorIntent_Leave value)?  leave,TResult Function( OrchestratorIntent_Answer value)?  answer,TResult Function( OrchestratorIntent_Dismiss value)?  dismiss,TResult Function( OrchestratorIntent_Close value)?  close,required TResult orElse(),}){
final _that = this;
switch (_that) {
case OrchestratorIntent_SetOnline() when setOnline != null:
return setOnline(_that);case OrchestratorIntent_SetVisible() when setVisible != null:
return setVisible(_that);case OrchestratorIntent_ReadCatalog() when readCatalog != null:
return readCatalog(_that);case OrchestratorIntent_CatalogShown() when catalogShown != null:
return catalogShown(_that);case OrchestratorIntent_WatchEntries() when watchEntries != null:
return watchEntries(_that);case OrchestratorIntent_Enter() when enter != null:
return enter(_that);case OrchestratorIntent_Entered() when entered != null:
return entered(_that);case OrchestratorIntent_Leave() when leave != null:
return leave(_that);case OrchestratorIntent_Answer() when answer != null:
return answer(_that);case OrchestratorIntent_Dismiss() when dismiss != null:
return dismiss(_that);case OrchestratorIntent_Close() when close != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( OrchestratorIntent_SetOnline value)  setOnline,required TResult Function( OrchestratorIntent_SetVisible value)  setVisible,required TResult Function( OrchestratorIntent_ReadCatalog value)  readCatalog,required TResult Function( OrchestratorIntent_CatalogShown value)  catalogShown,required TResult Function( OrchestratorIntent_WatchEntries value)  watchEntries,required TResult Function( OrchestratorIntent_Enter value)  enter,required TResult Function( OrchestratorIntent_Entered value)  entered,required TResult Function( OrchestratorIntent_Leave value)  leave,required TResult Function( OrchestratorIntent_Answer value)  answer,required TResult Function( OrchestratorIntent_Dismiss value)  dismiss,required TResult Function( OrchestratorIntent_Close value)  close,}){
final _that = this;
switch (_that) {
case OrchestratorIntent_SetOnline():
return setOnline(_that);case OrchestratorIntent_SetVisible():
return setVisible(_that);case OrchestratorIntent_ReadCatalog():
return readCatalog(_that);case OrchestratorIntent_CatalogShown():
return catalogShown(_that);case OrchestratorIntent_WatchEntries():
return watchEntries(_that);case OrchestratorIntent_Enter():
return enter(_that);case OrchestratorIntent_Entered():
return entered(_that);case OrchestratorIntent_Leave():
return leave(_that);case OrchestratorIntent_Answer():
return answer(_that);case OrchestratorIntent_Dismiss():
return dismiss(_that);case OrchestratorIntent_Close():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( OrchestratorIntent_SetOnline value)?  setOnline,TResult? Function( OrchestratorIntent_SetVisible value)?  setVisible,TResult? Function( OrchestratorIntent_ReadCatalog value)?  readCatalog,TResult? Function( OrchestratorIntent_CatalogShown value)?  catalogShown,TResult? Function( OrchestratorIntent_WatchEntries value)?  watchEntries,TResult? Function( OrchestratorIntent_Enter value)?  enter,TResult? Function( OrchestratorIntent_Entered value)?  entered,TResult? Function( OrchestratorIntent_Leave value)?  leave,TResult? Function( OrchestratorIntent_Answer value)?  answer,TResult? Function( OrchestratorIntent_Dismiss value)?  dismiss,TResult? Function( OrchestratorIntent_Close value)?  close,}){
final _that = this;
switch (_that) {
case OrchestratorIntent_SetOnline() when setOnline != null:
return setOnline(_that);case OrchestratorIntent_SetVisible() when setVisible != null:
return setVisible(_that);case OrchestratorIntent_ReadCatalog() when readCatalog != null:
return readCatalog(_that);case OrchestratorIntent_CatalogShown() when catalogShown != null:
return catalogShown(_that);case OrchestratorIntent_WatchEntries() when watchEntries != null:
return watchEntries(_that);case OrchestratorIntent_Enter() when enter != null:
return enter(_that);case OrchestratorIntent_Entered() when entered != null:
return entered(_that);case OrchestratorIntent_Leave() when leave != null:
return leave(_that);case OrchestratorIntent_Answer() when answer != null:
return answer(_that);case OrchestratorIntent_Dismiss() when dismiss != null:
return dismiss(_that);case OrchestratorIntent_Close() when close != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( bool online)?  setOnline,TResult Function( bool visible)?  setVisible,TResult Function()?  readCatalog,TResult Function()?  catalogShown,TResult Function()?  watchEntries,TResult Function( String? entryId)?  enter,TResult Function( int generation,  bool opened)?  entered,TResult Function()?  leave,TResult Function( String chatId,  String requestId,  List<QuestionAnswerView> answers)?  answer,TResult Function( String chatId,  String requestId)?  dismiss,TResult Function()?  close,required TResult orElse(),}) {final _that = this;
switch (_that) {
case OrchestratorIntent_SetOnline() when setOnline != null:
return setOnline(_that.online);case OrchestratorIntent_SetVisible() when setVisible != null:
return setVisible(_that.visible);case OrchestratorIntent_ReadCatalog() when readCatalog != null:
return readCatalog();case OrchestratorIntent_CatalogShown() when catalogShown != null:
return catalogShown();case OrchestratorIntent_WatchEntries() when watchEntries != null:
return watchEntries();case OrchestratorIntent_Enter() when enter != null:
return enter(_that.entryId);case OrchestratorIntent_Entered() when entered != null:
return entered(_that.generation,_that.opened);case OrchestratorIntent_Leave() when leave != null:
return leave();case OrchestratorIntent_Answer() when answer != null:
return answer(_that.chatId,_that.requestId,_that.answers);case OrchestratorIntent_Dismiss() when dismiss != null:
return dismiss(_that.chatId,_that.requestId);case OrchestratorIntent_Close() when close != null:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( bool online)  setOnline,required TResult Function( bool visible)  setVisible,required TResult Function()  readCatalog,required TResult Function()  catalogShown,required TResult Function()  watchEntries,required TResult Function( String? entryId)  enter,required TResult Function( int generation,  bool opened)  entered,required TResult Function()  leave,required TResult Function( String chatId,  String requestId,  List<QuestionAnswerView> answers)  answer,required TResult Function( String chatId,  String requestId)  dismiss,required TResult Function()  close,}) {final _that = this;
switch (_that) {
case OrchestratorIntent_SetOnline():
return setOnline(_that.online);case OrchestratorIntent_SetVisible():
return setVisible(_that.visible);case OrchestratorIntent_ReadCatalog():
return readCatalog();case OrchestratorIntent_CatalogShown():
return catalogShown();case OrchestratorIntent_WatchEntries():
return watchEntries();case OrchestratorIntent_Enter():
return enter(_that.entryId);case OrchestratorIntent_Entered():
return entered(_that.generation,_that.opened);case OrchestratorIntent_Leave():
return leave();case OrchestratorIntent_Answer():
return answer(_that.chatId,_that.requestId,_that.answers);case OrchestratorIntent_Dismiss():
return dismiss(_that.chatId,_that.requestId);case OrchestratorIntent_Close():
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( bool online)?  setOnline,TResult? Function( bool visible)?  setVisible,TResult? Function()?  readCatalog,TResult? Function()?  catalogShown,TResult? Function()?  watchEntries,TResult? Function( String? entryId)?  enter,TResult? Function( int generation,  bool opened)?  entered,TResult? Function()?  leave,TResult? Function( String chatId,  String requestId,  List<QuestionAnswerView> answers)?  answer,TResult? Function( String chatId,  String requestId)?  dismiss,TResult? Function()?  close,}) {final _that = this;
switch (_that) {
case OrchestratorIntent_SetOnline() when setOnline != null:
return setOnline(_that.online);case OrchestratorIntent_SetVisible() when setVisible != null:
return setVisible(_that.visible);case OrchestratorIntent_ReadCatalog() when readCatalog != null:
return readCatalog();case OrchestratorIntent_CatalogShown() when catalogShown != null:
return catalogShown();case OrchestratorIntent_WatchEntries() when watchEntries != null:
return watchEntries();case OrchestratorIntent_Enter() when enter != null:
return enter(_that.entryId);case OrchestratorIntent_Entered() when entered != null:
return entered(_that.generation,_that.opened);case OrchestratorIntent_Leave() when leave != null:
return leave();case OrchestratorIntent_Answer() when answer != null:
return answer(_that.chatId,_that.requestId,_that.answers);case OrchestratorIntent_Dismiss() when dismiss != null:
return dismiss(_that.chatId,_that.requestId);case OrchestratorIntent_Close() when close != null:
return close();case _:
  return null;

}
}

}

/// @nodoc


class OrchestratorIntent_SetOnline extends OrchestratorIntent {
  const OrchestratorIntent_SetOnline({required this.online}): super._();
  

 final  bool online;

/// Create a copy of OrchestratorIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$OrchestratorIntent_SetOnlineCopyWith<OrchestratorIntent_SetOnline> get copyWith => _$OrchestratorIntent_SetOnlineCopyWithImpl<OrchestratorIntent_SetOnline>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorIntent_SetOnline&&(identical(other.online, online) || other.online == online));
}


@override
int get hashCode => Object.hash(runtimeType,online);

@override
String toString() {
  return 'OrchestratorIntent.setOnline(online: $online)';
}


}

/// @nodoc
abstract mixin class $OrchestratorIntent_SetOnlineCopyWith<$Res> implements $OrchestratorIntentCopyWith<$Res> {
  factory $OrchestratorIntent_SetOnlineCopyWith(OrchestratorIntent_SetOnline value, $Res Function(OrchestratorIntent_SetOnline) _then) = _$OrchestratorIntent_SetOnlineCopyWithImpl;
@useResult
$Res call({
 bool online
});




}
/// @nodoc
class _$OrchestratorIntent_SetOnlineCopyWithImpl<$Res>
    implements $OrchestratorIntent_SetOnlineCopyWith<$Res> {
  _$OrchestratorIntent_SetOnlineCopyWithImpl(this._self, this._then);

  final OrchestratorIntent_SetOnline _self;
  final $Res Function(OrchestratorIntent_SetOnline) _then;

/// Create a copy of OrchestratorIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? online = null,}) {
  return _then(OrchestratorIntent_SetOnline(
online: null == online ? _self.online : online // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class OrchestratorIntent_SetVisible extends OrchestratorIntent {
  const OrchestratorIntent_SetVisible({required this.visible}): super._();
  

 final  bool visible;

/// Create a copy of OrchestratorIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$OrchestratorIntent_SetVisibleCopyWith<OrchestratorIntent_SetVisible> get copyWith => _$OrchestratorIntent_SetVisibleCopyWithImpl<OrchestratorIntent_SetVisible>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorIntent_SetVisible&&(identical(other.visible, visible) || other.visible == visible));
}


@override
int get hashCode => Object.hash(runtimeType,visible);

@override
String toString() {
  return 'OrchestratorIntent.setVisible(visible: $visible)';
}


}

/// @nodoc
abstract mixin class $OrchestratorIntent_SetVisibleCopyWith<$Res> implements $OrchestratorIntentCopyWith<$Res> {
  factory $OrchestratorIntent_SetVisibleCopyWith(OrchestratorIntent_SetVisible value, $Res Function(OrchestratorIntent_SetVisible) _then) = _$OrchestratorIntent_SetVisibleCopyWithImpl;
@useResult
$Res call({
 bool visible
});




}
/// @nodoc
class _$OrchestratorIntent_SetVisibleCopyWithImpl<$Res>
    implements $OrchestratorIntent_SetVisibleCopyWith<$Res> {
  _$OrchestratorIntent_SetVisibleCopyWithImpl(this._self, this._then);

  final OrchestratorIntent_SetVisible _self;
  final $Res Function(OrchestratorIntent_SetVisible) _then;

/// Create a copy of OrchestratorIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? visible = null,}) {
  return _then(OrchestratorIntent_SetVisible(
visible: null == visible ? _self.visible : visible // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class OrchestratorIntent_ReadCatalog extends OrchestratorIntent {
  const OrchestratorIntent_ReadCatalog(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorIntent_ReadCatalog);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'OrchestratorIntent.readCatalog()';
}


}




/// @nodoc


class OrchestratorIntent_CatalogShown extends OrchestratorIntent {
  const OrchestratorIntent_CatalogShown(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorIntent_CatalogShown);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'OrchestratorIntent.catalogShown()';
}


}




/// @nodoc


class OrchestratorIntent_WatchEntries extends OrchestratorIntent {
  const OrchestratorIntent_WatchEntries(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorIntent_WatchEntries);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'OrchestratorIntent.watchEntries()';
}


}




/// @nodoc


class OrchestratorIntent_Enter extends OrchestratorIntent {
  const OrchestratorIntent_Enter({this.entryId}): super._();
  

 final  String? entryId;

/// Create a copy of OrchestratorIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$OrchestratorIntent_EnterCopyWith<OrchestratorIntent_Enter> get copyWith => _$OrchestratorIntent_EnterCopyWithImpl<OrchestratorIntent_Enter>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorIntent_Enter&&(identical(other.entryId, entryId) || other.entryId == entryId));
}


@override
int get hashCode => Object.hash(runtimeType,entryId);

@override
String toString() {
  return 'OrchestratorIntent.enter(entryId: $entryId)';
}


}

/// @nodoc
abstract mixin class $OrchestratorIntent_EnterCopyWith<$Res> implements $OrchestratorIntentCopyWith<$Res> {
  factory $OrchestratorIntent_EnterCopyWith(OrchestratorIntent_Enter value, $Res Function(OrchestratorIntent_Enter) _then) = _$OrchestratorIntent_EnterCopyWithImpl;
@useResult
$Res call({
 String? entryId
});




}
/// @nodoc
class _$OrchestratorIntent_EnterCopyWithImpl<$Res>
    implements $OrchestratorIntent_EnterCopyWith<$Res> {
  _$OrchestratorIntent_EnterCopyWithImpl(this._self, this._then);

  final OrchestratorIntent_Enter _self;
  final $Res Function(OrchestratorIntent_Enter) _then;

/// Create a copy of OrchestratorIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? entryId = freezed,}) {
  return _then(OrchestratorIntent_Enter(
entryId: freezed == entryId ? _self.entryId : entryId // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}

/// @nodoc


class OrchestratorIntent_Entered extends OrchestratorIntent {
  const OrchestratorIntent_Entered({required this.generation, required this.opened}): super._();
  

 final  int generation;
 final  bool opened;

/// Create a copy of OrchestratorIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$OrchestratorIntent_EnteredCopyWith<OrchestratorIntent_Entered> get copyWith => _$OrchestratorIntent_EnteredCopyWithImpl<OrchestratorIntent_Entered>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorIntent_Entered&&(identical(other.generation, generation) || other.generation == generation)&&(identical(other.opened, opened) || other.opened == opened));
}


@override
int get hashCode => Object.hash(runtimeType,generation,opened);

@override
String toString() {
  return 'OrchestratorIntent.entered(generation: $generation, opened: $opened)';
}


}

/// @nodoc
abstract mixin class $OrchestratorIntent_EnteredCopyWith<$Res> implements $OrchestratorIntentCopyWith<$Res> {
  factory $OrchestratorIntent_EnteredCopyWith(OrchestratorIntent_Entered value, $Res Function(OrchestratorIntent_Entered) _then) = _$OrchestratorIntent_EnteredCopyWithImpl;
@useResult
$Res call({
 int generation, bool opened
});




}
/// @nodoc
class _$OrchestratorIntent_EnteredCopyWithImpl<$Res>
    implements $OrchestratorIntent_EnteredCopyWith<$Res> {
  _$OrchestratorIntent_EnteredCopyWithImpl(this._self, this._then);

  final OrchestratorIntent_Entered _self;
  final $Res Function(OrchestratorIntent_Entered) _then;

/// Create a copy of OrchestratorIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? generation = null,Object? opened = null,}) {
  return _then(OrchestratorIntent_Entered(
generation: null == generation ? _self.generation : generation // ignore: cast_nullable_to_non_nullable
as int,opened: null == opened ? _self.opened : opened // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class OrchestratorIntent_Leave extends OrchestratorIntent {
  const OrchestratorIntent_Leave(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorIntent_Leave);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'OrchestratorIntent.leave()';
}


}




/// @nodoc


class OrchestratorIntent_Answer extends OrchestratorIntent {
  const OrchestratorIntent_Answer({required this.chatId, required this.requestId, required final  List<QuestionAnswerView> answers}): _answers = answers,super._();
  

 final  String chatId;
 final  String requestId;
 final  List<QuestionAnswerView> _answers;
 List<QuestionAnswerView> get answers {
  if (_answers is EqualUnmodifiableListView) return _answers;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_answers);
}


/// Create a copy of OrchestratorIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$OrchestratorIntent_AnswerCopyWith<OrchestratorIntent_Answer> get copyWith => _$OrchestratorIntent_AnswerCopyWithImpl<OrchestratorIntent_Answer>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorIntent_Answer&&(identical(other.chatId, chatId) || other.chatId == chatId)&&(identical(other.requestId, requestId) || other.requestId == requestId)&&const DeepCollectionEquality().equals(other._answers, _answers));
}


@override
int get hashCode => Object.hash(runtimeType,chatId,requestId,const DeepCollectionEquality().hash(_answers));

@override
String toString() {
  return 'OrchestratorIntent.answer(chatId: $chatId, requestId: $requestId, answers: $answers)';
}


}

/// @nodoc
abstract mixin class $OrchestratorIntent_AnswerCopyWith<$Res> implements $OrchestratorIntentCopyWith<$Res> {
  factory $OrchestratorIntent_AnswerCopyWith(OrchestratorIntent_Answer value, $Res Function(OrchestratorIntent_Answer) _then) = _$OrchestratorIntent_AnswerCopyWithImpl;
@useResult
$Res call({
 String chatId, String requestId, List<QuestionAnswerView> answers
});




}
/// @nodoc
class _$OrchestratorIntent_AnswerCopyWithImpl<$Res>
    implements $OrchestratorIntent_AnswerCopyWith<$Res> {
  _$OrchestratorIntent_AnswerCopyWithImpl(this._self, this._then);

  final OrchestratorIntent_Answer _self;
  final $Res Function(OrchestratorIntent_Answer) _then;

/// Create a copy of OrchestratorIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chatId = null,Object? requestId = null,Object? answers = null,}) {
  return _then(OrchestratorIntent_Answer(
chatId: null == chatId ? _self.chatId : chatId // ignore: cast_nullable_to_non_nullable
as String,requestId: null == requestId ? _self.requestId : requestId // ignore: cast_nullable_to_non_nullable
as String,answers: null == answers ? _self._answers : answers // ignore: cast_nullable_to_non_nullable
as List<QuestionAnswerView>,
  ));
}


}

/// @nodoc


class OrchestratorIntent_Dismiss extends OrchestratorIntent {
  const OrchestratorIntent_Dismiss({required this.chatId, required this.requestId}): super._();
  

 final  String chatId;
 final  String requestId;

/// Create a copy of OrchestratorIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$OrchestratorIntent_DismissCopyWith<OrchestratorIntent_Dismiss> get copyWith => _$OrchestratorIntent_DismissCopyWithImpl<OrchestratorIntent_Dismiss>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorIntent_Dismiss&&(identical(other.chatId, chatId) || other.chatId == chatId)&&(identical(other.requestId, requestId) || other.requestId == requestId));
}


@override
int get hashCode => Object.hash(runtimeType,chatId,requestId);

@override
String toString() {
  return 'OrchestratorIntent.dismiss(chatId: $chatId, requestId: $requestId)';
}


}

/// @nodoc
abstract mixin class $OrchestratorIntent_DismissCopyWith<$Res> implements $OrchestratorIntentCopyWith<$Res> {
  factory $OrchestratorIntent_DismissCopyWith(OrchestratorIntent_Dismiss value, $Res Function(OrchestratorIntent_Dismiss) _then) = _$OrchestratorIntent_DismissCopyWithImpl;
@useResult
$Res call({
 String chatId, String requestId
});




}
/// @nodoc
class _$OrchestratorIntent_DismissCopyWithImpl<$Res>
    implements $OrchestratorIntent_DismissCopyWith<$Res> {
  _$OrchestratorIntent_DismissCopyWithImpl(this._self, this._then);

  final OrchestratorIntent_Dismiss _self;
  final $Res Function(OrchestratorIntent_Dismiss) _then;

/// Create a copy of OrchestratorIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chatId = null,Object? requestId = null,}) {
  return _then(OrchestratorIntent_Dismiss(
chatId: null == chatId ? _self.chatId : chatId // ignore: cast_nullable_to_non_nullable
as String,requestId: null == requestId ? _self.requestId : requestId // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class OrchestratorIntent_Close extends OrchestratorIntent {
  const OrchestratorIntent_Close(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorIntent_Close);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'OrchestratorIntent.close()';
}


}




/// @nodoc
mixin _$OrchestratorOutcome {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorOutcome);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'OrchestratorOutcome()';
}


}

/// @nodoc
class $OrchestratorOutcomeCopyWith<$Res>  {
$OrchestratorOutcomeCopyWith(OrchestratorOutcome _, $Res Function(OrchestratorOutcome) __);
}


/// Adds pattern-matching-related methods to [OrchestratorOutcome].
extension OrchestratorOutcomePatterns on OrchestratorOutcome {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( OrchestratorOutcome_Visible value)?  visible,TResult Function( OrchestratorOutcome_Catalog value)?  catalog,TResult Function( OrchestratorOutcome_Busy value)?  busy,TResult Function( OrchestratorOutcome_Open value)?  open,TResult Function( OrchestratorOutcome_NewChat value)?  newChat,TResult Function( OrchestratorOutcome_NewTab value)?  newTab,TResult Function( OrchestratorOutcome_LoadFailed value)?  loadFailed,TResult Function( OrchestratorOutcome_Stale value)?  stale,TResult Function( OrchestratorOutcome_Entered value)?  entered,TResult Function( OrchestratorOutcome_Failed value)?  failed,TResult Function( OrchestratorOutcome_Done value)?  done,required TResult orElse(),}){
final _that = this;
switch (_that) {
case OrchestratorOutcome_Visible() when visible != null:
return visible(_that);case OrchestratorOutcome_Catalog() when catalog != null:
return catalog(_that);case OrchestratorOutcome_Busy() when busy != null:
return busy(_that);case OrchestratorOutcome_Open() when open != null:
return open(_that);case OrchestratorOutcome_NewChat() when newChat != null:
return newChat(_that);case OrchestratorOutcome_NewTab() when newTab != null:
return newTab(_that);case OrchestratorOutcome_LoadFailed() when loadFailed != null:
return loadFailed(_that);case OrchestratorOutcome_Stale() when stale != null:
return stale(_that);case OrchestratorOutcome_Entered() when entered != null:
return entered(_that);case OrchestratorOutcome_Failed() when failed != null:
return failed(_that);case OrchestratorOutcome_Done() when done != null:
return done(_that);case _:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( OrchestratorOutcome_Visible value)  visible,required TResult Function( OrchestratorOutcome_Catalog value)  catalog,required TResult Function( OrchestratorOutcome_Busy value)  busy,required TResult Function( OrchestratorOutcome_Open value)  open,required TResult Function( OrchestratorOutcome_NewChat value)  newChat,required TResult Function( OrchestratorOutcome_NewTab value)  newTab,required TResult Function( OrchestratorOutcome_LoadFailed value)  loadFailed,required TResult Function( OrchestratorOutcome_Stale value)  stale,required TResult Function( OrchestratorOutcome_Entered value)  entered,required TResult Function( OrchestratorOutcome_Failed value)  failed,required TResult Function( OrchestratorOutcome_Done value)  done,}){
final _that = this;
switch (_that) {
case OrchestratorOutcome_Visible():
return visible(_that);case OrchestratorOutcome_Catalog():
return catalog(_that);case OrchestratorOutcome_Busy():
return busy(_that);case OrchestratorOutcome_Open():
return open(_that);case OrchestratorOutcome_NewChat():
return newChat(_that);case OrchestratorOutcome_NewTab():
return newTab(_that);case OrchestratorOutcome_LoadFailed():
return loadFailed(_that);case OrchestratorOutcome_Stale():
return stale(_that);case OrchestratorOutcome_Entered():
return entered(_that);case OrchestratorOutcome_Failed():
return failed(_that);case OrchestratorOutcome_Done():
return done(_that);}
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( OrchestratorOutcome_Visible value)?  visible,TResult? Function( OrchestratorOutcome_Catalog value)?  catalog,TResult? Function( OrchestratorOutcome_Busy value)?  busy,TResult? Function( OrchestratorOutcome_Open value)?  open,TResult? Function( OrchestratorOutcome_NewChat value)?  newChat,TResult? Function( OrchestratorOutcome_NewTab value)?  newTab,TResult? Function( OrchestratorOutcome_LoadFailed value)?  loadFailed,TResult? Function( OrchestratorOutcome_Stale value)?  stale,TResult? Function( OrchestratorOutcome_Entered value)?  entered,TResult? Function( OrchestratorOutcome_Failed value)?  failed,TResult? Function( OrchestratorOutcome_Done value)?  done,}){
final _that = this;
switch (_that) {
case OrchestratorOutcome_Visible() when visible != null:
return visible(_that);case OrchestratorOutcome_Catalog() when catalog != null:
return catalog(_that);case OrchestratorOutcome_Busy() when busy != null:
return busy(_that);case OrchestratorOutcome_Open() when open != null:
return open(_that);case OrchestratorOutcome_NewChat() when newChat != null:
return newChat(_that);case OrchestratorOutcome_NewTab() when newTab != null:
return newTab(_that);case OrchestratorOutcome_LoadFailed() when loadFailed != null:
return loadFailed(_that);case OrchestratorOutcome_Stale() when stale != null:
return stale(_that);case OrchestratorOutcome_Entered() when entered != null:
return entered(_that);case OrchestratorOutcome_Failed() when failed != null:
return failed(_that);case OrchestratorOutcome_Done() when done != null:
return done(_that);case _:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( bool refresh)?  visible,TResult Function( CatalogView catalog)?  catalog,TResult Function()?  busy,TResult Function( ChatRefView chat,  int generation)?  open,TResult Function( CatalogWorkspaceView workspace,  int generation)?  newChat,TResult Function( String entryId,  int generation,  String failure)?  newTab,TResult Function( String message)?  loadFailed,TResult Function()?  stale,TResult Function( bool opened)?  entered,TResult Function( ChatFailure failure)?  failed,TResult Function()?  done,required TResult orElse(),}) {final _that = this;
switch (_that) {
case OrchestratorOutcome_Visible() when visible != null:
return visible(_that.refresh);case OrchestratorOutcome_Catalog() when catalog != null:
return catalog(_that.catalog);case OrchestratorOutcome_Busy() when busy != null:
return busy();case OrchestratorOutcome_Open() when open != null:
return open(_that.chat,_that.generation);case OrchestratorOutcome_NewChat() when newChat != null:
return newChat(_that.workspace,_that.generation);case OrchestratorOutcome_NewTab() when newTab != null:
return newTab(_that.entryId,_that.generation,_that.failure);case OrchestratorOutcome_LoadFailed() when loadFailed != null:
return loadFailed(_that.message);case OrchestratorOutcome_Stale() when stale != null:
return stale();case OrchestratorOutcome_Entered() when entered != null:
return entered(_that.opened);case OrchestratorOutcome_Failed() when failed != null:
return failed(_that.failure);case OrchestratorOutcome_Done() when done != null:
return done();case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( bool refresh)  visible,required TResult Function( CatalogView catalog)  catalog,required TResult Function()  busy,required TResult Function( ChatRefView chat,  int generation)  open,required TResult Function( CatalogWorkspaceView workspace,  int generation)  newChat,required TResult Function( String entryId,  int generation,  String failure)  newTab,required TResult Function( String message)  loadFailed,required TResult Function()  stale,required TResult Function( bool opened)  entered,required TResult Function( ChatFailure failure)  failed,required TResult Function()  done,}) {final _that = this;
switch (_that) {
case OrchestratorOutcome_Visible():
return visible(_that.refresh);case OrchestratorOutcome_Catalog():
return catalog(_that.catalog);case OrchestratorOutcome_Busy():
return busy();case OrchestratorOutcome_Open():
return open(_that.chat,_that.generation);case OrchestratorOutcome_NewChat():
return newChat(_that.workspace,_that.generation);case OrchestratorOutcome_NewTab():
return newTab(_that.entryId,_that.generation,_that.failure);case OrchestratorOutcome_LoadFailed():
return loadFailed(_that.message);case OrchestratorOutcome_Stale():
return stale();case OrchestratorOutcome_Entered():
return entered(_that.opened);case OrchestratorOutcome_Failed():
return failed(_that.failure);case OrchestratorOutcome_Done():
return done();}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( bool refresh)?  visible,TResult? Function( CatalogView catalog)?  catalog,TResult? Function()?  busy,TResult? Function( ChatRefView chat,  int generation)?  open,TResult? Function( CatalogWorkspaceView workspace,  int generation)?  newChat,TResult? Function( String entryId,  int generation,  String failure)?  newTab,TResult? Function( String message)?  loadFailed,TResult? Function()?  stale,TResult? Function( bool opened)?  entered,TResult? Function( ChatFailure failure)?  failed,TResult? Function()?  done,}) {final _that = this;
switch (_that) {
case OrchestratorOutcome_Visible() when visible != null:
return visible(_that.refresh);case OrchestratorOutcome_Catalog() when catalog != null:
return catalog(_that.catalog);case OrchestratorOutcome_Busy() when busy != null:
return busy();case OrchestratorOutcome_Open() when open != null:
return open(_that.chat,_that.generation);case OrchestratorOutcome_NewChat() when newChat != null:
return newChat(_that.workspace,_that.generation);case OrchestratorOutcome_NewTab() when newTab != null:
return newTab(_that.entryId,_that.generation,_that.failure);case OrchestratorOutcome_LoadFailed() when loadFailed != null:
return loadFailed(_that.message);case OrchestratorOutcome_Stale() when stale != null:
return stale();case OrchestratorOutcome_Entered() when entered != null:
return entered(_that.opened);case OrchestratorOutcome_Failed() when failed != null:
return failed(_that.failure);case OrchestratorOutcome_Done() when done != null:
return done();case _:
  return null;

}
}

}

/// @nodoc


class OrchestratorOutcome_Visible extends OrchestratorOutcome {
  const OrchestratorOutcome_Visible({required this.refresh}): super._();
  

 final  bool refresh;

/// Create a copy of OrchestratorOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$OrchestratorOutcome_VisibleCopyWith<OrchestratorOutcome_Visible> get copyWith => _$OrchestratorOutcome_VisibleCopyWithImpl<OrchestratorOutcome_Visible>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorOutcome_Visible&&(identical(other.refresh, refresh) || other.refresh == refresh));
}


@override
int get hashCode => Object.hash(runtimeType,refresh);

@override
String toString() {
  return 'OrchestratorOutcome.visible(refresh: $refresh)';
}


}

/// @nodoc
abstract mixin class $OrchestratorOutcome_VisibleCopyWith<$Res> implements $OrchestratorOutcomeCopyWith<$Res> {
  factory $OrchestratorOutcome_VisibleCopyWith(OrchestratorOutcome_Visible value, $Res Function(OrchestratorOutcome_Visible) _then) = _$OrchestratorOutcome_VisibleCopyWithImpl;
@useResult
$Res call({
 bool refresh
});




}
/// @nodoc
class _$OrchestratorOutcome_VisibleCopyWithImpl<$Res>
    implements $OrchestratorOutcome_VisibleCopyWith<$Res> {
  _$OrchestratorOutcome_VisibleCopyWithImpl(this._self, this._then);

  final OrchestratorOutcome_Visible _self;
  final $Res Function(OrchestratorOutcome_Visible) _then;

/// Create a copy of OrchestratorOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? refresh = null,}) {
  return _then(OrchestratorOutcome_Visible(
refresh: null == refresh ? _self.refresh : refresh // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class OrchestratorOutcome_Catalog extends OrchestratorOutcome {
  const OrchestratorOutcome_Catalog({required this.catalog}): super._();
  

 final  CatalogView catalog;

/// Create a copy of OrchestratorOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$OrchestratorOutcome_CatalogCopyWith<OrchestratorOutcome_Catalog> get copyWith => _$OrchestratorOutcome_CatalogCopyWithImpl<OrchestratorOutcome_Catalog>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorOutcome_Catalog&&(identical(other.catalog, catalog) || other.catalog == catalog));
}


@override
int get hashCode => Object.hash(runtimeType,catalog);

@override
String toString() {
  return 'OrchestratorOutcome.catalog(catalog: $catalog)';
}


}

/// @nodoc
abstract mixin class $OrchestratorOutcome_CatalogCopyWith<$Res> implements $OrchestratorOutcomeCopyWith<$Res> {
  factory $OrchestratorOutcome_CatalogCopyWith(OrchestratorOutcome_Catalog value, $Res Function(OrchestratorOutcome_Catalog) _then) = _$OrchestratorOutcome_CatalogCopyWithImpl;
@useResult
$Res call({
 CatalogView catalog
});




}
/// @nodoc
class _$OrchestratorOutcome_CatalogCopyWithImpl<$Res>
    implements $OrchestratorOutcome_CatalogCopyWith<$Res> {
  _$OrchestratorOutcome_CatalogCopyWithImpl(this._self, this._then);

  final OrchestratorOutcome_Catalog _self;
  final $Res Function(OrchestratorOutcome_Catalog) _then;

/// Create a copy of OrchestratorOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? catalog = null,}) {
  return _then(OrchestratorOutcome_Catalog(
catalog: null == catalog ? _self.catalog : catalog // ignore: cast_nullable_to_non_nullable
as CatalogView,
  ));
}


}

/// @nodoc


class OrchestratorOutcome_Busy extends OrchestratorOutcome {
  const OrchestratorOutcome_Busy(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorOutcome_Busy);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'OrchestratorOutcome.busy()';
}


}




/// @nodoc


class OrchestratorOutcome_Open extends OrchestratorOutcome {
  const OrchestratorOutcome_Open({required this.chat, required this.generation}): super._();
  

 final  ChatRefView chat;
 final  int generation;

/// Create a copy of OrchestratorOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$OrchestratorOutcome_OpenCopyWith<OrchestratorOutcome_Open> get copyWith => _$OrchestratorOutcome_OpenCopyWithImpl<OrchestratorOutcome_Open>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorOutcome_Open&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.generation, generation) || other.generation == generation));
}


@override
int get hashCode => Object.hash(runtimeType,chat,generation);

@override
String toString() {
  return 'OrchestratorOutcome.open(chat: $chat, generation: $generation)';
}


}

/// @nodoc
abstract mixin class $OrchestratorOutcome_OpenCopyWith<$Res> implements $OrchestratorOutcomeCopyWith<$Res> {
  factory $OrchestratorOutcome_OpenCopyWith(OrchestratorOutcome_Open value, $Res Function(OrchestratorOutcome_Open) _then) = _$OrchestratorOutcome_OpenCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, int generation
});




}
/// @nodoc
class _$OrchestratorOutcome_OpenCopyWithImpl<$Res>
    implements $OrchestratorOutcome_OpenCopyWith<$Res> {
  _$OrchestratorOutcome_OpenCopyWithImpl(this._self, this._then);

  final OrchestratorOutcome_Open _self;
  final $Res Function(OrchestratorOutcome_Open) _then;

/// Create a copy of OrchestratorOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? generation = null,}) {
  return _then(OrchestratorOutcome_Open(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,generation: null == generation ? _self.generation : generation // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}

/// @nodoc


class OrchestratorOutcome_NewChat extends OrchestratorOutcome {
  const OrchestratorOutcome_NewChat({required this.workspace, required this.generation}): super._();
  

 final  CatalogWorkspaceView workspace;
 final  int generation;

/// Create a copy of OrchestratorOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$OrchestratorOutcome_NewChatCopyWith<OrchestratorOutcome_NewChat> get copyWith => _$OrchestratorOutcome_NewChatCopyWithImpl<OrchestratorOutcome_NewChat>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorOutcome_NewChat&&(identical(other.workspace, workspace) || other.workspace == workspace)&&(identical(other.generation, generation) || other.generation == generation));
}


@override
int get hashCode => Object.hash(runtimeType,workspace,generation);

@override
String toString() {
  return 'OrchestratorOutcome.newChat(workspace: $workspace, generation: $generation)';
}


}

/// @nodoc
abstract mixin class $OrchestratorOutcome_NewChatCopyWith<$Res> implements $OrchestratorOutcomeCopyWith<$Res> {
  factory $OrchestratorOutcome_NewChatCopyWith(OrchestratorOutcome_NewChat value, $Res Function(OrchestratorOutcome_NewChat) _then) = _$OrchestratorOutcome_NewChatCopyWithImpl;
@useResult
$Res call({
 CatalogWorkspaceView workspace, int generation
});




}
/// @nodoc
class _$OrchestratorOutcome_NewChatCopyWithImpl<$Res>
    implements $OrchestratorOutcome_NewChatCopyWith<$Res> {
  _$OrchestratorOutcome_NewChatCopyWithImpl(this._self, this._then);

  final OrchestratorOutcome_NewChat _self;
  final $Res Function(OrchestratorOutcome_NewChat) _then;

/// Create a copy of OrchestratorOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? workspace = null,Object? generation = null,}) {
  return _then(OrchestratorOutcome_NewChat(
workspace: null == workspace ? _self.workspace : workspace // ignore: cast_nullable_to_non_nullable
as CatalogWorkspaceView,generation: null == generation ? _self.generation : generation // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}

/// @nodoc


class OrchestratorOutcome_NewTab extends OrchestratorOutcome {
  const OrchestratorOutcome_NewTab({required this.entryId, required this.generation, required this.failure}): super._();
  

 final  String entryId;
 final  int generation;
 final  String failure;

/// Create a copy of OrchestratorOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$OrchestratorOutcome_NewTabCopyWith<OrchestratorOutcome_NewTab> get copyWith => _$OrchestratorOutcome_NewTabCopyWithImpl<OrchestratorOutcome_NewTab>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorOutcome_NewTab&&(identical(other.entryId, entryId) || other.entryId == entryId)&&(identical(other.generation, generation) || other.generation == generation)&&(identical(other.failure, failure) || other.failure == failure));
}


@override
int get hashCode => Object.hash(runtimeType,entryId,generation,failure);

@override
String toString() {
  return 'OrchestratorOutcome.newTab(entryId: $entryId, generation: $generation, failure: $failure)';
}


}

/// @nodoc
abstract mixin class $OrchestratorOutcome_NewTabCopyWith<$Res> implements $OrchestratorOutcomeCopyWith<$Res> {
  factory $OrchestratorOutcome_NewTabCopyWith(OrchestratorOutcome_NewTab value, $Res Function(OrchestratorOutcome_NewTab) _then) = _$OrchestratorOutcome_NewTabCopyWithImpl;
@useResult
$Res call({
 String entryId, int generation, String failure
});




}
/// @nodoc
class _$OrchestratorOutcome_NewTabCopyWithImpl<$Res>
    implements $OrchestratorOutcome_NewTabCopyWith<$Res> {
  _$OrchestratorOutcome_NewTabCopyWithImpl(this._self, this._then);

  final OrchestratorOutcome_NewTab _self;
  final $Res Function(OrchestratorOutcome_NewTab) _then;

/// Create a copy of OrchestratorOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? entryId = null,Object? generation = null,Object? failure = null,}) {
  return _then(OrchestratorOutcome_NewTab(
entryId: null == entryId ? _self.entryId : entryId // ignore: cast_nullable_to_non_nullable
as String,generation: null == generation ? _self.generation : generation // ignore: cast_nullable_to_non_nullable
as int,failure: null == failure ? _self.failure : failure // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class OrchestratorOutcome_LoadFailed extends OrchestratorOutcome {
  const OrchestratorOutcome_LoadFailed({required this.message}): super._();
  

 final  String message;

/// Create a copy of OrchestratorOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$OrchestratorOutcome_LoadFailedCopyWith<OrchestratorOutcome_LoadFailed> get copyWith => _$OrchestratorOutcome_LoadFailedCopyWithImpl<OrchestratorOutcome_LoadFailed>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorOutcome_LoadFailed&&(identical(other.message, message) || other.message == message));
}


@override
int get hashCode => Object.hash(runtimeType,message);

@override
String toString() {
  return 'OrchestratorOutcome.loadFailed(message: $message)';
}


}

/// @nodoc
abstract mixin class $OrchestratorOutcome_LoadFailedCopyWith<$Res> implements $OrchestratorOutcomeCopyWith<$Res> {
  factory $OrchestratorOutcome_LoadFailedCopyWith(OrchestratorOutcome_LoadFailed value, $Res Function(OrchestratorOutcome_LoadFailed) _then) = _$OrchestratorOutcome_LoadFailedCopyWithImpl;
@useResult
$Res call({
 String message
});




}
/// @nodoc
class _$OrchestratorOutcome_LoadFailedCopyWithImpl<$Res>
    implements $OrchestratorOutcome_LoadFailedCopyWith<$Res> {
  _$OrchestratorOutcome_LoadFailedCopyWithImpl(this._self, this._then);

  final OrchestratorOutcome_LoadFailed _self;
  final $Res Function(OrchestratorOutcome_LoadFailed) _then;

/// Create a copy of OrchestratorOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? message = null,}) {
  return _then(OrchestratorOutcome_LoadFailed(
message: null == message ? _self.message : message // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class OrchestratorOutcome_Stale extends OrchestratorOutcome {
  const OrchestratorOutcome_Stale(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorOutcome_Stale);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'OrchestratorOutcome.stale()';
}


}




/// @nodoc


class OrchestratorOutcome_Entered extends OrchestratorOutcome {
  const OrchestratorOutcome_Entered({required this.opened}): super._();
  

 final  bool opened;

/// Create a copy of OrchestratorOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$OrchestratorOutcome_EnteredCopyWith<OrchestratorOutcome_Entered> get copyWith => _$OrchestratorOutcome_EnteredCopyWithImpl<OrchestratorOutcome_Entered>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorOutcome_Entered&&(identical(other.opened, opened) || other.opened == opened));
}


@override
int get hashCode => Object.hash(runtimeType,opened);

@override
String toString() {
  return 'OrchestratorOutcome.entered(opened: $opened)';
}


}

/// @nodoc
abstract mixin class $OrchestratorOutcome_EnteredCopyWith<$Res> implements $OrchestratorOutcomeCopyWith<$Res> {
  factory $OrchestratorOutcome_EnteredCopyWith(OrchestratorOutcome_Entered value, $Res Function(OrchestratorOutcome_Entered) _then) = _$OrchestratorOutcome_EnteredCopyWithImpl;
@useResult
$Res call({
 bool opened
});




}
/// @nodoc
class _$OrchestratorOutcome_EnteredCopyWithImpl<$Res>
    implements $OrchestratorOutcome_EnteredCopyWith<$Res> {
  _$OrchestratorOutcome_EnteredCopyWithImpl(this._self, this._then);

  final OrchestratorOutcome_Entered _self;
  final $Res Function(OrchestratorOutcome_Entered) _then;

/// Create a copy of OrchestratorOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? opened = null,}) {
  return _then(OrchestratorOutcome_Entered(
opened: null == opened ? _self.opened : opened // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class OrchestratorOutcome_Failed extends OrchestratorOutcome {
  const OrchestratorOutcome_Failed({required this.failure}): super._();
  

 final  ChatFailure failure;

/// Create a copy of OrchestratorOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$OrchestratorOutcome_FailedCopyWith<OrchestratorOutcome_Failed> get copyWith => _$OrchestratorOutcome_FailedCopyWithImpl<OrchestratorOutcome_Failed>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorOutcome_Failed&&(identical(other.failure, failure) || other.failure == failure));
}


@override
int get hashCode => Object.hash(runtimeType,failure);

@override
String toString() {
  return 'OrchestratorOutcome.failed(failure: $failure)';
}


}

/// @nodoc
abstract mixin class $OrchestratorOutcome_FailedCopyWith<$Res> implements $OrchestratorOutcomeCopyWith<$Res> {
  factory $OrchestratorOutcome_FailedCopyWith(OrchestratorOutcome_Failed value, $Res Function(OrchestratorOutcome_Failed) _then) = _$OrchestratorOutcome_FailedCopyWithImpl;
@useResult
$Res call({
 ChatFailure failure
});




}
/// @nodoc
class _$OrchestratorOutcome_FailedCopyWithImpl<$Res>
    implements $OrchestratorOutcome_FailedCopyWith<$Res> {
  _$OrchestratorOutcome_FailedCopyWithImpl(this._self, this._then);

  final OrchestratorOutcome_Failed _self;
  final $Res Function(OrchestratorOutcome_Failed) _then;

/// Create a copy of OrchestratorOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? failure = null,}) {
  return _then(OrchestratorOutcome_Failed(
failure: null == failure ? _self.failure : failure // ignore: cast_nullable_to_non_nullable
as ChatFailure,
  ));
}


}

/// @nodoc


class OrchestratorOutcome_Done extends OrchestratorOutcome {
  const OrchestratorOutcome_Done(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is OrchestratorOutcome_Done);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'OrchestratorOutcome.done()';
}


}




// dart format on
