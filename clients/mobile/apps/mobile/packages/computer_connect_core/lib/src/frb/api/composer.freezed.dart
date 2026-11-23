// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'composer.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;
/// @nodoc
mixin _$SettingsPick {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SettingsPick);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'SettingsPick()';
}


}

/// @nodoc
class $SettingsPickCopyWith<$Res>  {
$SettingsPickCopyWith(SettingsPick _, $Res Function(SettingsPick) __);
}


/// Adds pattern-matching-related methods to [SettingsPick].
extension SettingsPickPatterns on SettingsPick {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( SettingsPick_Effort value)?  effort,TResult Function( SettingsPick_Auto value)?  auto,TResult Function( SettingsPick_PlanMode value)?  planMode,TResult Function( SettingsPick_Model value)?  model,TResult Function( SettingsPick_Fast value)?  fast,required TResult orElse(),}){
final _that = this;
switch (_that) {
case SettingsPick_Effort() when effort != null:
return effort(_that);case SettingsPick_Auto() when auto != null:
return auto(_that);case SettingsPick_PlanMode() when planMode != null:
return planMode(_that);case SettingsPick_Model() when model != null:
return model(_that);case SettingsPick_Fast() when fast != null:
return fast(_that);case _:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( SettingsPick_Effort value)  effort,required TResult Function( SettingsPick_Auto value)  auto,required TResult Function( SettingsPick_PlanMode value)  planMode,required TResult Function( SettingsPick_Model value)  model,required TResult Function( SettingsPick_Fast value)  fast,}){
final _that = this;
switch (_that) {
case SettingsPick_Effort():
return effort(_that);case SettingsPick_Auto():
return auto(_that);case SettingsPick_PlanMode():
return planMode(_that);case SettingsPick_Model():
return model(_that);case SettingsPick_Fast():
return fast(_that);}
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( SettingsPick_Effort value)?  effort,TResult? Function( SettingsPick_Auto value)?  auto,TResult? Function( SettingsPick_PlanMode value)?  planMode,TResult? Function( SettingsPick_Model value)?  model,TResult? Function( SettingsPick_Fast value)?  fast,}){
final _that = this;
switch (_that) {
case SettingsPick_Effort() when effort != null:
return effort(_that);case SettingsPick_Auto() when auto != null:
return auto(_that);case SettingsPick_PlanMode() when planMode != null:
return planMode(_that);case SettingsPick_Model() when model != null:
return model(_that);case SettingsPick_Fast() when fast != null:
return fast(_that);case _:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( String level)?  effort,TResult Function()?  auto,TResult Function( bool enabled)?  planMode,TResult Function( String id,  String? executionHarness)?  model,TResult Function( bool fast)?  fast,required TResult orElse(),}) {final _that = this;
switch (_that) {
case SettingsPick_Effort() when effort != null:
return effort(_that.level);case SettingsPick_Auto() when auto != null:
return auto();case SettingsPick_PlanMode() when planMode != null:
return planMode(_that.enabled);case SettingsPick_Model() when model != null:
return model(_that.id,_that.executionHarness);case SettingsPick_Fast() when fast != null:
return fast(_that.fast);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( String level)  effort,required TResult Function()  auto,required TResult Function( bool enabled)  planMode,required TResult Function( String id,  String? executionHarness)  model,required TResult Function( bool fast)  fast,}) {final _that = this;
switch (_that) {
case SettingsPick_Effort():
return effort(_that.level);case SettingsPick_Auto():
return auto();case SettingsPick_PlanMode():
return planMode(_that.enabled);case SettingsPick_Model():
return model(_that.id,_that.executionHarness);case SettingsPick_Fast():
return fast(_that.fast);}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( String level)?  effort,TResult? Function()?  auto,TResult? Function( bool enabled)?  planMode,TResult? Function( String id,  String? executionHarness)?  model,TResult? Function( bool fast)?  fast,}) {final _that = this;
switch (_that) {
case SettingsPick_Effort() when effort != null:
return effort(_that.level);case SettingsPick_Auto() when auto != null:
return auto();case SettingsPick_PlanMode() when planMode != null:
return planMode(_that.enabled);case SettingsPick_Model() when model != null:
return model(_that.id,_that.executionHarness);case SettingsPick_Fast() when fast != null:
return fast(_that.fast);case _:
  return null;

}
}

}

/// @nodoc


class SettingsPick_Effort extends SettingsPick {
  const SettingsPick_Effort({required this.level}): super._();
  

 final  String level;

/// Create a copy of SettingsPick
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$SettingsPick_EffortCopyWith<SettingsPick_Effort> get copyWith => _$SettingsPick_EffortCopyWithImpl<SettingsPick_Effort>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SettingsPick_Effort&&(identical(other.level, level) || other.level == level));
}


@override
int get hashCode => Object.hash(runtimeType,level);

@override
String toString() {
  return 'SettingsPick.effort(level: $level)';
}


}

/// @nodoc
abstract mixin class $SettingsPick_EffortCopyWith<$Res> implements $SettingsPickCopyWith<$Res> {
  factory $SettingsPick_EffortCopyWith(SettingsPick_Effort value, $Res Function(SettingsPick_Effort) _then) = _$SettingsPick_EffortCopyWithImpl;
@useResult
$Res call({
 String level
});




}
/// @nodoc
class _$SettingsPick_EffortCopyWithImpl<$Res>
    implements $SettingsPick_EffortCopyWith<$Res> {
  _$SettingsPick_EffortCopyWithImpl(this._self, this._then);

  final SettingsPick_Effort _self;
  final $Res Function(SettingsPick_Effort) _then;

/// Create a copy of SettingsPick
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? level = null,}) {
  return _then(SettingsPick_Effort(
level: null == level ? _self.level : level // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class SettingsPick_Auto extends SettingsPick {
  const SettingsPick_Auto(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SettingsPick_Auto);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'SettingsPick.auto()';
}


}




/// @nodoc


class SettingsPick_PlanMode extends SettingsPick {
  const SettingsPick_PlanMode({required this.enabled}): super._();
  

 final  bool enabled;

/// Create a copy of SettingsPick
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$SettingsPick_PlanModeCopyWith<SettingsPick_PlanMode> get copyWith => _$SettingsPick_PlanModeCopyWithImpl<SettingsPick_PlanMode>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SettingsPick_PlanMode&&(identical(other.enabled, enabled) || other.enabled == enabled));
}


@override
int get hashCode => Object.hash(runtimeType,enabled);

@override
String toString() {
  return 'SettingsPick.planMode(enabled: $enabled)';
}


}

/// @nodoc
abstract mixin class $SettingsPick_PlanModeCopyWith<$Res> implements $SettingsPickCopyWith<$Res> {
  factory $SettingsPick_PlanModeCopyWith(SettingsPick_PlanMode value, $Res Function(SettingsPick_PlanMode) _then) = _$SettingsPick_PlanModeCopyWithImpl;
@useResult
$Res call({
 bool enabled
});




}
/// @nodoc
class _$SettingsPick_PlanModeCopyWithImpl<$Res>
    implements $SettingsPick_PlanModeCopyWith<$Res> {
  _$SettingsPick_PlanModeCopyWithImpl(this._self, this._then);

  final SettingsPick_PlanMode _self;
  final $Res Function(SettingsPick_PlanMode) _then;

/// Create a copy of SettingsPick
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? enabled = null,}) {
  return _then(SettingsPick_PlanMode(
enabled: null == enabled ? _self.enabled : enabled // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class SettingsPick_Model extends SettingsPick {
  const SettingsPick_Model({required this.id, this.executionHarness}): super._();
  

 final  String id;
 final  String? executionHarness;

/// Create a copy of SettingsPick
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$SettingsPick_ModelCopyWith<SettingsPick_Model> get copyWith => _$SettingsPick_ModelCopyWithImpl<SettingsPick_Model>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SettingsPick_Model&&(identical(other.id, id) || other.id == id)&&(identical(other.executionHarness, executionHarness) || other.executionHarness == executionHarness));
}


@override
int get hashCode => Object.hash(runtimeType,id,executionHarness);

@override
String toString() {
  return 'SettingsPick.model(id: $id, executionHarness: $executionHarness)';
}


}

/// @nodoc
abstract mixin class $SettingsPick_ModelCopyWith<$Res> implements $SettingsPickCopyWith<$Res> {
  factory $SettingsPick_ModelCopyWith(SettingsPick_Model value, $Res Function(SettingsPick_Model) _then) = _$SettingsPick_ModelCopyWithImpl;
@useResult
$Res call({
 String id, String? executionHarness
});




}
/// @nodoc
class _$SettingsPick_ModelCopyWithImpl<$Res>
    implements $SettingsPick_ModelCopyWith<$Res> {
  _$SettingsPick_ModelCopyWithImpl(this._self, this._then);

  final SettingsPick_Model _self;
  final $Res Function(SettingsPick_Model) _then;

/// Create a copy of SettingsPick
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? id = null,Object? executionHarness = freezed,}) {
  return _then(SettingsPick_Model(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,executionHarness: freezed == executionHarness ? _self.executionHarness : executionHarness // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}

/// @nodoc


class SettingsPick_Fast extends SettingsPick {
  const SettingsPick_Fast({required this.fast}): super._();
  

 final  bool fast;

/// Create a copy of SettingsPick
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$SettingsPick_FastCopyWith<SettingsPick_Fast> get copyWith => _$SettingsPick_FastCopyWithImpl<SettingsPick_Fast>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SettingsPick_Fast&&(identical(other.fast, fast) || other.fast == fast));
}


@override
int get hashCode => Object.hash(runtimeType,fast);

@override
String toString() {
  return 'SettingsPick.fast(fast: $fast)';
}


}

/// @nodoc
abstract mixin class $SettingsPick_FastCopyWith<$Res> implements $SettingsPickCopyWith<$Res> {
  factory $SettingsPick_FastCopyWith(SettingsPick_Fast value, $Res Function(SettingsPick_Fast) _then) = _$SettingsPick_FastCopyWithImpl;
@useResult
$Res call({
 bool fast
});




}
/// @nodoc
class _$SettingsPick_FastCopyWithImpl<$Res>
    implements $SettingsPick_FastCopyWith<$Res> {
  _$SettingsPick_FastCopyWithImpl(this._self, this._then);

  final SettingsPick_Fast _self;
  final $Res Function(SettingsPick_Fast) _then;

/// Create a copy of SettingsPick
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? fast = null,}) {
  return _then(SettingsPick_Fast(
fast: null == fast ? _self.fast : fast // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

// dart format on
