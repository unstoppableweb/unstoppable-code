// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'diagnostics.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;
/// @nodoc
mixin _$CacheScope {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is CacheScope);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'CacheScope()';
}


}

/// @nodoc
class $CacheScopeCopyWith<$Res>  {
$CacheScopeCopyWith(CacheScope _, $Res Function(CacheScope) __);
}


/// Adds pattern-matching-related methods to [CacheScope].
extension CacheScopePatterns on CacheScope {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( CacheScope_Account value)?  account,TResult Function( CacheScope_Computer value)?  computer,TResult Function( CacheScope_Entry value)?  entry,required TResult orElse(),}){
final _that = this;
switch (_that) {
case CacheScope_Account() when account != null:
return account(_that);case CacheScope_Computer() when computer != null:
return computer(_that);case CacheScope_Entry() when entry != null:
return entry(_that);case _:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( CacheScope_Account value)  account,required TResult Function( CacheScope_Computer value)  computer,required TResult Function( CacheScope_Entry value)  entry,}){
final _that = this;
switch (_that) {
case CacheScope_Account():
return account(_that);case CacheScope_Computer():
return computer(_that);case CacheScope_Entry():
return entry(_that);}
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( CacheScope_Account value)?  account,TResult? Function( CacheScope_Computer value)?  computer,TResult? Function( CacheScope_Entry value)?  entry,}){
final _that = this;
switch (_that) {
case CacheScope_Account() when account != null:
return account(_that);case CacheScope_Computer() when computer != null:
return computer(_that);case CacheScope_Entry() when entry != null:
return entry(_that);case _:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function()?  account,TResult Function( String computerId)?  computer,TResult Function( String computerId,  String key)?  entry,required TResult orElse(),}) {final _that = this;
switch (_that) {
case CacheScope_Account() when account != null:
return account();case CacheScope_Computer() when computer != null:
return computer(_that.computerId);case CacheScope_Entry() when entry != null:
return entry(_that.computerId,_that.key);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function()  account,required TResult Function( String computerId)  computer,required TResult Function( String computerId,  String key)  entry,}) {final _that = this;
switch (_that) {
case CacheScope_Account():
return account();case CacheScope_Computer():
return computer(_that.computerId);case CacheScope_Entry():
return entry(_that.computerId,_that.key);}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function()?  account,TResult? Function( String computerId)?  computer,TResult? Function( String computerId,  String key)?  entry,}) {final _that = this;
switch (_that) {
case CacheScope_Account() when account != null:
return account();case CacheScope_Computer() when computer != null:
return computer(_that.computerId);case CacheScope_Entry() when entry != null:
return entry(_that.computerId,_that.key);case _:
  return null;

}
}

}

/// @nodoc


class CacheScope_Account extends CacheScope {
  const CacheScope_Account(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is CacheScope_Account);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'CacheScope.account()';
}


}




/// @nodoc


class CacheScope_Computer extends CacheScope {
  const CacheScope_Computer({required this.computerId}): super._();
  

 final  String computerId;

/// Create a copy of CacheScope
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$CacheScope_ComputerCopyWith<CacheScope_Computer> get copyWith => _$CacheScope_ComputerCopyWithImpl<CacheScope_Computer>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is CacheScope_Computer&&(identical(other.computerId, computerId) || other.computerId == computerId));
}


@override
int get hashCode => Object.hash(runtimeType,computerId);

@override
String toString() {
  return 'CacheScope.computer(computerId: $computerId)';
}


}

/// @nodoc
abstract mixin class $CacheScope_ComputerCopyWith<$Res> implements $CacheScopeCopyWith<$Res> {
  factory $CacheScope_ComputerCopyWith(CacheScope_Computer value, $Res Function(CacheScope_Computer) _then) = _$CacheScope_ComputerCopyWithImpl;
@useResult
$Res call({
 String computerId
});




}
/// @nodoc
class _$CacheScope_ComputerCopyWithImpl<$Res>
    implements $CacheScope_ComputerCopyWith<$Res> {
  _$CacheScope_ComputerCopyWithImpl(this._self, this._then);

  final CacheScope_Computer _self;
  final $Res Function(CacheScope_Computer) _then;

/// Create a copy of CacheScope
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? computerId = null,}) {
  return _then(CacheScope_Computer(
computerId: null == computerId ? _self.computerId : computerId // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class CacheScope_Entry extends CacheScope {
  const CacheScope_Entry({required this.computerId, required this.key}): super._();
  

 final  String computerId;
 final  String key;

/// Create a copy of CacheScope
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$CacheScope_EntryCopyWith<CacheScope_Entry> get copyWith => _$CacheScope_EntryCopyWithImpl<CacheScope_Entry>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is CacheScope_Entry&&(identical(other.computerId, computerId) || other.computerId == computerId)&&(identical(other.key, key) || other.key == key));
}


@override
int get hashCode => Object.hash(runtimeType,computerId,key);

@override
String toString() {
  return 'CacheScope.entry(computerId: $computerId, key: $key)';
}


}

/// @nodoc
abstract mixin class $CacheScope_EntryCopyWith<$Res> implements $CacheScopeCopyWith<$Res> {
  factory $CacheScope_EntryCopyWith(CacheScope_Entry value, $Res Function(CacheScope_Entry) _then) = _$CacheScope_EntryCopyWithImpl;
@useResult
$Res call({
 String computerId, String key
});




}
/// @nodoc
class _$CacheScope_EntryCopyWithImpl<$Res>
    implements $CacheScope_EntryCopyWith<$Res> {
  _$CacheScope_EntryCopyWithImpl(this._self, this._then);

  final CacheScope_Entry _self;
  final $Res Function(CacheScope_Entry) _then;

/// Create a copy of CacheScope
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? computerId = null,Object? key = null,}) {
  return _then(CacheScope_Entry(
computerId: null == computerId ? _self.computerId : computerId // ignore: cast_nullable_to_non_nullable
as String,key: null == key ? _self.key : key // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

// dart format on
