// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'worktrees.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;
/// @nodoc
mixin _$WorktreesIntent {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is WorktreesIntent);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'WorktreesIntent()';
}


}

/// @nodoc
class $WorktreesIntentCopyWith<$Res>  {
$WorktreesIntentCopyWith(WorktreesIntent _, $Res Function(WorktreesIntent) __);
}


/// Adds pattern-matching-related methods to [WorktreesIntent].
extension WorktreesIntentPatterns on WorktreesIntent {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( WorktreesIntent_Create value)?  create,TResult Function( WorktreesIntent_Release value)?  release,TResult Function( WorktreesIntent_Archive value)?  archive,TResult Function( WorktreesIntent_Close value)?  close,required TResult orElse(),}){
final _that = this;
switch (_that) {
case WorktreesIntent_Create() when create != null:
return create(_that);case WorktreesIntent_Release() when release != null:
return release(_that);case WorktreesIntent_Archive() when archive != null:
return archive(_that);case WorktreesIntent_Close() when close != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( WorktreesIntent_Create value)  create,required TResult Function( WorktreesIntent_Release value)  release,required TResult Function( WorktreesIntent_Archive value)  archive,required TResult Function( WorktreesIntent_Close value)  close,}){
final _that = this;
switch (_that) {
case WorktreesIntent_Create():
return create(_that);case WorktreesIntent_Release():
return release(_that);case WorktreesIntent_Archive():
return archive(_that);case WorktreesIntent_Close():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( WorktreesIntent_Create value)?  create,TResult? Function( WorktreesIntent_Release value)?  release,TResult? Function( WorktreesIntent_Archive value)?  archive,TResult? Function( WorktreesIntent_Close value)?  close,}){
final _that = this;
switch (_that) {
case WorktreesIntent_Create() when create != null:
return create(_that);case WorktreesIntent_Release() when release != null:
return release(_that);case WorktreesIntent_Archive() when archive != null:
return archive(_that);case WorktreesIntent_Close() when close != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( int attempt)?  create,TResult Function( int attempt)?  release,TResult Function( String projectId,  String worktreeId)?  archive,TResult Function()?  close,required TResult orElse(),}) {final _that = this;
switch (_that) {
case WorktreesIntent_Create() when create != null:
return create(_that.attempt);case WorktreesIntent_Release() when release != null:
return release(_that.attempt);case WorktreesIntent_Archive() when archive != null:
return archive(_that.projectId,_that.worktreeId);case WorktreesIntent_Close() when close != null:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( int attempt)  create,required TResult Function( int attempt)  release,required TResult Function( String projectId,  String worktreeId)  archive,required TResult Function()  close,}) {final _that = this;
switch (_that) {
case WorktreesIntent_Create():
return create(_that.attempt);case WorktreesIntent_Release():
return release(_that.attempt);case WorktreesIntent_Archive():
return archive(_that.projectId,_that.worktreeId);case WorktreesIntent_Close():
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( int attempt)?  create,TResult? Function( int attempt)?  release,TResult? Function( String projectId,  String worktreeId)?  archive,TResult? Function()?  close,}) {final _that = this;
switch (_that) {
case WorktreesIntent_Create() when create != null:
return create(_that.attempt);case WorktreesIntent_Release() when release != null:
return release(_that.attempt);case WorktreesIntent_Archive() when archive != null:
return archive(_that.projectId,_that.worktreeId);case WorktreesIntent_Close() when close != null:
return close();case _:
  return null;

}
}

}

/// @nodoc


class WorktreesIntent_Create extends WorktreesIntent {
  const WorktreesIntent_Create({required this.attempt}): super._();
  

 final  int attempt;

/// Create a copy of WorktreesIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$WorktreesIntent_CreateCopyWith<WorktreesIntent_Create> get copyWith => _$WorktreesIntent_CreateCopyWithImpl<WorktreesIntent_Create>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is WorktreesIntent_Create&&(identical(other.attempt, attempt) || other.attempt == attempt));
}


@override
int get hashCode => Object.hash(runtimeType,attempt);

@override
String toString() {
  return 'WorktreesIntent.create(attempt: $attempt)';
}


}

/// @nodoc
abstract mixin class $WorktreesIntent_CreateCopyWith<$Res> implements $WorktreesIntentCopyWith<$Res> {
  factory $WorktreesIntent_CreateCopyWith(WorktreesIntent_Create value, $Res Function(WorktreesIntent_Create) _then) = _$WorktreesIntent_CreateCopyWithImpl;
@useResult
$Res call({
 int attempt
});




}
/// @nodoc
class _$WorktreesIntent_CreateCopyWithImpl<$Res>
    implements $WorktreesIntent_CreateCopyWith<$Res> {
  _$WorktreesIntent_CreateCopyWithImpl(this._self, this._then);

  final WorktreesIntent_Create _self;
  final $Res Function(WorktreesIntent_Create) _then;

/// Create a copy of WorktreesIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? attempt = null,}) {
  return _then(WorktreesIntent_Create(
attempt: null == attempt ? _self.attempt : attempt // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}

/// @nodoc


class WorktreesIntent_Release extends WorktreesIntent {
  const WorktreesIntent_Release({required this.attempt}): super._();
  

 final  int attempt;

/// Create a copy of WorktreesIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$WorktreesIntent_ReleaseCopyWith<WorktreesIntent_Release> get copyWith => _$WorktreesIntent_ReleaseCopyWithImpl<WorktreesIntent_Release>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is WorktreesIntent_Release&&(identical(other.attempt, attempt) || other.attempt == attempt));
}


@override
int get hashCode => Object.hash(runtimeType,attempt);

@override
String toString() {
  return 'WorktreesIntent.release(attempt: $attempt)';
}


}

/// @nodoc
abstract mixin class $WorktreesIntent_ReleaseCopyWith<$Res> implements $WorktreesIntentCopyWith<$Res> {
  factory $WorktreesIntent_ReleaseCopyWith(WorktreesIntent_Release value, $Res Function(WorktreesIntent_Release) _then) = _$WorktreesIntent_ReleaseCopyWithImpl;
@useResult
$Res call({
 int attempt
});




}
/// @nodoc
class _$WorktreesIntent_ReleaseCopyWithImpl<$Res>
    implements $WorktreesIntent_ReleaseCopyWith<$Res> {
  _$WorktreesIntent_ReleaseCopyWithImpl(this._self, this._then);

  final WorktreesIntent_Release _self;
  final $Res Function(WorktreesIntent_Release) _then;

/// Create a copy of WorktreesIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? attempt = null,}) {
  return _then(WorktreesIntent_Release(
attempt: null == attempt ? _self.attempt : attempt // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}

/// @nodoc


class WorktreesIntent_Archive extends WorktreesIntent {
  const WorktreesIntent_Archive({required this.projectId, required this.worktreeId}): super._();
  

 final  String projectId;
 final  String worktreeId;

/// Create a copy of WorktreesIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$WorktreesIntent_ArchiveCopyWith<WorktreesIntent_Archive> get copyWith => _$WorktreesIntent_ArchiveCopyWithImpl<WorktreesIntent_Archive>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is WorktreesIntent_Archive&&(identical(other.projectId, projectId) || other.projectId == projectId)&&(identical(other.worktreeId, worktreeId) || other.worktreeId == worktreeId));
}


@override
int get hashCode => Object.hash(runtimeType,projectId,worktreeId);

@override
String toString() {
  return 'WorktreesIntent.archive(projectId: $projectId, worktreeId: $worktreeId)';
}


}

/// @nodoc
abstract mixin class $WorktreesIntent_ArchiveCopyWith<$Res> implements $WorktreesIntentCopyWith<$Res> {
  factory $WorktreesIntent_ArchiveCopyWith(WorktreesIntent_Archive value, $Res Function(WorktreesIntent_Archive) _then) = _$WorktreesIntent_ArchiveCopyWithImpl;
@useResult
$Res call({
 String projectId, String worktreeId
});




}
/// @nodoc
class _$WorktreesIntent_ArchiveCopyWithImpl<$Res>
    implements $WorktreesIntent_ArchiveCopyWith<$Res> {
  _$WorktreesIntent_ArchiveCopyWithImpl(this._self, this._then);

  final WorktreesIntent_Archive _self;
  final $Res Function(WorktreesIntent_Archive) _then;

/// Create a copy of WorktreesIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? projectId = null,Object? worktreeId = null,}) {
  return _then(WorktreesIntent_Archive(
projectId: null == projectId ? _self.projectId : projectId // ignore: cast_nullable_to_non_nullable
as String,worktreeId: null == worktreeId ? _self.worktreeId : worktreeId // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class WorktreesIntent_Close extends WorktreesIntent {
  const WorktreesIntent_Close(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is WorktreesIntent_Close);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'WorktreesIntent.close()';
}


}




// dart format on
