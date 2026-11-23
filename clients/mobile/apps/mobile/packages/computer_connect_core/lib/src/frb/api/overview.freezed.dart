// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'overview.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;
/// @nodoc
mixin _$WorktreeLoad {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is WorktreeLoad);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'WorktreeLoad()';
}


}

/// @nodoc
class $WorktreeLoadCopyWith<$Res>  {
$WorktreeLoadCopyWith(WorktreeLoad _, $Res Function(WorktreeLoad) __);
}


/// Adds pattern-matching-related methods to [WorktreeLoad].
extension WorktreeLoadPatterns on WorktreeLoad {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( WorktreeLoad_Loaded value)?  loaded,TResult Function( WorktreeLoad_Unavailable value)?  unavailable,TResult Function( WorktreeLoad_Stale value)?  stale,required TResult orElse(),}){
final _that = this;
switch (_that) {
case WorktreeLoad_Loaded() when loaded != null:
return loaded(_that);case WorktreeLoad_Unavailable() when unavailable != null:
return unavailable(_that);case WorktreeLoad_Stale() when stale != null:
return stale(_that);case _:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( WorktreeLoad_Loaded value)  loaded,required TResult Function( WorktreeLoad_Unavailable value)  unavailable,required TResult Function( WorktreeLoad_Stale value)  stale,}){
final _that = this;
switch (_that) {
case WorktreeLoad_Loaded():
return loaded(_that);case WorktreeLoad_Unavailable():
return unavailable(_that);case WorktreeLoad_Stale():
return stale(_that);}
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( WorktreeLoad_Loaded value)?  loaded,TResult? Function( WorktreeLoad_Unavailable value)?  unavailable,TResult? Function( WorktreeLoad_Stale value)?  stale,}){
final _that = this;
switch (_that) {
case WorktreeLoad_Loaded() when loaded != null:
return loaded(_that);case WorktreeLoad_Unavailable() when unavailable != null:
return unavailable(_that);case WorktreeLoad_Stale() when stale != null:
return stale(_that);case _:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( WorktreeChatsView field0)?  loaded,TResult Function()?  unavailable,TResult Function()?  stale,required TResult orElse(),}) {final _that = this;
switch (_that) {
case WorktreeLoad_Loaded() when loaded != null:
return loaded(_that.field0);case WorktreeLoad_Unavailable() when unavailable != null:
return unavailable();case WorktreeLoad_Stale() when stale != null:
return stale();case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( WorktreeChatsView field0)  loaded,required TResult Function()  unavailable,required TResult Function()  stale,}) {final _that = this;
switch (_that) {
case WorktreeLoad_Loaded():
return loaded(_that.field0);case WorktreeLoad_Unavailable():
return unavailable();case WorktreeLoad_Stale():
return stale();}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( WorktreeChatsView field0)?  loaded,TResult? Function()?  unavailable,TResult? Function()?  stale,}) {final _that = this;
switch (_that) {
case WorktreeLoad_Loaded() when loaded != null:
return loaded(_that.field0);case WorktreeLoad_Unavailable() when unavailable != null:
return unavailable();case WorktreeLoad_Stale() when stale != null:
return stale();case _:
  return null;

}
}

}

/// @nodoc


class WorktreeLoad_Loaded extends WorktreeLoad {
  const WorktreeLoad_Loaded(this.field0): super._();
  

 final  WorktreeChatsView field0;

/// Create a copy of WorktreeLoad
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$WorktreeLoad_LoadedCopyWith<WorktreeLoad_Loaded> get copyWith => _$WorktreeLoad_LoadedCopyWithImpl<WorktreeLoad_Loaded>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is WorktreeLoad_Loaded&&(identical(other.field0, field0) || other.field0 == field0));
}


@override
int get hashCode => Object.hash(runtimeType,field0);

@override
String toString() {
  return 'WorktreeLoad.loaded(field0: $field0)';
}


}

/// @nodoc
abstract mixin class $WorktreeLoad_LoadedCopyWith<$Res> implements $WorktreeLoadCopyWith<$Res> {
  factory $WorktreeLoad_LoadedCopyWith(WorktreeLoad_Loaded value, $Res Function(WorktreeLoad_Loaded) _then) = _$WorktreeLoad_LoadedCopyWithImpl;
@useResult
$Res call({
 WorktreeChatsView field0
});




}
/// @nodoc
class _$WorktreeLoad_LoadedCopyWithImpl<$Res>
    implements $WorktreeLoad_LoadedCopyWith<$Res> {
  _$WorktreeLoad_LoadedCopyWithImpl(this._self, this._then);

  final WorktreeLoad_Loaded _self;
  final $Res Function(WorktreeLoad_Loaded) _then;

/// Create a copy of WorktreeLoad
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? field0 = null,}) {
  return _then(WorktreeLoad_Loaded(
null == field0 ? _self.field0 : field0 // ignore: cast_nullable_to_non_nullable
as WorktreeChatsView,
  ));
}


}

/// @nodoc


class WorktreeLoad_Unavailable extends WorktreeLoad {
  const WorktreeLoad_Unavailable(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is WorktreeLoad_Unavailable);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'WorktreeLoad.unavailable()';
}


}




/// @nodoc


class WorktreeLoad_Stale extends WorktreeLoad {
  const WorktreeLoad_Stale(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is WorktreeLoad_Stale);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'WorktreeLoad.stale()';
}


}




// dart format on
