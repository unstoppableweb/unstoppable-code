// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'auth.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;
/// @nodoc
mixin _$AuthSession {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is AuthSession);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'AuthSession()';
}


}

/// @nodoc
class $AuthSessionCopyWith<$Res>  {
$AuthSessionCopyWith(AuthSession _, $Res Function(AuthSession) __);
}


/// Adds pattern-matching-related methods to [AuthSession].
extension AuthSessionPatterns on AuthSession {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( AuthSession_SignedIn value)?  signedIn,TResult Function( AuthSession_SignedOut value)?  signedOut,required TResult orElse(),}){
final _that = this;
switch (_that) {
case AuthSession_SignedIn() when signedIn != null:
return signedIn(_that);case AuthSession_SignedOut() when signedOut != null:
return signedOut(_that);case _:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( AuthSession_SignedIn value)  signedIn,required TResult Function( AuthSession_SignedOut value)  signedOut,}){
final _that = this;
switch (_that) {
case AuthSession_SignedIn():
return signedIn(_that);case AuthSession_SignedOut():
return signedOut(_that);}
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( AuthSession_SignedIn value)?  signedIn,TResult? Function( AuthSession_SignedOut value)?  signedOut,}){
final _that = this;
switch (_that) {
case AuthSession_SignedIn() when signedIn != null:
return signedIn(_that);case AuthSession_SignedOut() when signedOut != null:
return signedOut(_that);case _:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( SignedInView field0)?  signedIn,TResult Function()?  signedOut,required TResult orElse(),}) {final _that = this;
switch (_that) {
case AuthSession_SignedIn() when signedIn != null:
return signedIn(_that.field0);case AuthSession_SignedOut() when signedOut != null:
return signedOut();case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( SignedInView field0)  signedIn,required TResult Function()  signedOut,}) {final _that = this;
switch (_that) {
case AuthSession_SignedIn():
return signedIn(_that.field0);case AuthSession_SignedOut():
return signedOut();}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( SignedInView field0)?  signedIn,TResult? Function()?  signedOut,}) {final _that = this;
switch (_that) {
case AuthSession_SignedIn() when signedIn != null:
return signedIn(_that.field0);case AuthSession_SignedOut() when signedOut != null:
return signedOut();case _:
  return null;

}
}

}

/// @nodoc


class AuthSession_SignedIn extends AuthSession {
  const AuthSession_SignedIn(this.field0): super._();
  

 final  SignedInView field0;

/// Create a copy of AuthSession
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$AuthSession_SignedInCopyWith<AuthSession_SignedIn> get copyWith => _$AuthSession_SignedInCopyWithImpl<AuthSession_SignedIn>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is AuthSession_SignedIn&&(identical(other.field0, field0) || other.field0 == field0));
}


@override
int get hashCode => Object.hash(runtimeType,field0);

@override
String toString() {
  return 'AuthSession.signedIn(field0: $field0)';
}


}

/// @nodoc
abstract mixin class $AuthSession_SignedInCopyWith<$Res> implements $AuthSessionCopyWith<$Res> {
  factory $AuthSession_SignedInCopyWith(AuthSession_SignedIn value, $Res Function(AuthSession_SignedIn) _then) = _$AuthSession_SignedInCopyWithImpl;
@useResult
$Res call({
 SignedInView field0
});




}
/// @nodoc
class _$AuthSession_SignedInCopyWithImpl<$Res>
    implements $AuthSession_SignedInCopyWith<$Res> {
  _$AuthSession_SignedInCopyWithImpl(this._self, this._then);

  final AuthSession_SignedIn _self;
  final $Res Function(AuthSession_SignedIn) _then;

/// Create a copy of AuthSession
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? field0 = null,}) {
  return _then(AuthSession_SignedIn(
null == field0 ? _self.field0 : field0 // ignore: cast_nullable_to_non_nullable
as SignedInView,
  ));
}


}

/// @nodoc


class AuthSession_SignedOut extends AuthSession {
  const AuthSession_SignedOut(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is AuthSession_SignedOut);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'AuthSession.signedOut()';
}


}




/// @nodoc
mixin _$AuthStatus {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is AuthStatus);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'AuthStatus()';
}


}

/// @nodoc
class $AuthStatusCopyWith<$Res>  {
$AuthStatusCopyWith(AuthStatus _, $Res Function(AuthStatus) __);
}


/// Adds pattern-matching-related methods to [AuthStatus].
extension AuthStatusPatterns on AuthStatus {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( AuthStatus_SignedIn value)?  signedIn,TResult Function( AuthStatus_Unverified value)?  unverified,TResult Function( AuthStatus_SignedOut value)?  signedOut,required TResult orElse(),}){
final _that = this;
switch (_that) {
case AuthStatus_SignedIn() when signedIn != null:
return signedIn(_that);case AuthStatus_Unverified() when unverified != null:
return unverified(_that);case AuthStatus_SignedOut() when signedOut != null:
return signedOut(_that);case _:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( AuthStatus_SignedIn value)  signedIn,required TResult Function( AuthStatus_Unverified value)  unverified,required TResult Function( AuthStatus_SignedOut value)  signedOut,}){
final _that = this;
switch (_that) {
case AuthStatus_SignedIn():
return signedIn(_that);case AuthStatus_Unverified():
return unverified(_that);case AuthStatus_SignedOut():
return signedOut(_that);}
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( AuthStatus_SignedIn value)?  signedIn,TResult? Function( AuthStatus_Unverified value)?  unverified,TResult? Function( AuthStatus_SignedOut value)?  signedOut,}){
final _that = this;
switch (_that) {
case AuthStatus_SignedIn() when signedIn != null:
return signedIn(_that);case AuthStatus_Unverified() when unverified != null:
return unverified(_that);case AuthStatus_SignedOut() when signedOut != null:
return signedOut(_that);case _:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( SignedInView field0)?  signedIn,TResult Function( String? lastUserJson)?  unverified,TResult Function()?  signedOut,required TResult orElse(),}) {final _that = this;
switch (_that) {
case AuthStatus_SignedIn() when signedIn != null:
return signedIn(_that.field0);case AuthStatus_Unverified() when unverified != null:
return unverified(_that.lastUserJson);case AuthStatus_SignedOut() when signedOut != null:
return signedOut();case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( SignedInView field0)  signedIn,required TResult Function( String? lastUserJson)  unverified,required TResult Function()  signedOut,}) {final _that = this;
switch (_that) {
case AuthStatus_SignedIn():
return signedIn(_that.field0);case AuthStatus_Unverified():
return unverified(_that.lastUserJson);case AuthStatus_SignedOut():
return signedOut();}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( SignedInView field0)?  signedIn,TResult? Function( String? lastUserJson)?  unverified,TResult? Function()?  signedOut,}) {final _that = this;
switch (_that) {
case AuthStatus_SignedIn() when signedIn != null:
return signedIn(_that.field0);case AuthStatus_Unverified() when unverified != null:
return unverified(_that.lastUserJson);case AuthStatus_SignedOut() when signedOut != null:
return signedOut();case _:
  return null;

}
}

}

/// @nodoc


class AuthStatus_SignedIn extends AuthStatus {
  const AuthStatus_SignedIn(this.field0): super._();
  

 final  SignedInView field0;

/// Create a copy of AuthStatus
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$AuthStatus_SignedInCopyWith<AuthStatus_SignedIn> get copyWith => _$AuthStatus_SignedInCopyWithImpl<AuthStatus_SignedIn>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is AuthStatus_SignedIn&&(identical(other.field0, field0) || other.field0 == field0));
}


@override
int get hashCode => Object.hash(runtimeType,field0);

@override
String toString() {
  return 'AuthStatus.signedIn(field0: $field0)';
}


}

/// @nodoc
abstract mixin class $AuthStatus_SignedInCopyWith<$Res> implements $AuthStatusCopyWith<$Res> {
  factory $AuthStatus_SignedInCopyWith(AuthStatus_SignedIn value, $Res Function(AuthStatus_SignedIn) _then) = _$AuthStatus_SignedInCopyWithImpl;
@useResult
$Res call({
 SignedInView field0
});




}
/// @nodoc
class _$AuthStatus_SignedInCopyWithImpl<$Res>
    implements $AuthStatus_SignedInCopyWith<$Res> {
  _$AuthStatus_SignedInCopyWithImpl(this._self, this._then);

  final AuthStatus_SignedIn _self;
  final $Res Function(AuthStatus_SignedIn) _then;

/// Create a copy of AuthStatus
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? field0 = null,}) {
  return _then(AuthStatus_SignedIn(
null == field0 ? _self.field0 : field0 // ignore: cast_nullable_to_non_nullable
as SignedInView,
  ));
}


}

/// @nodoc


class AuthStatus_Unverified extends AuthStatus {
  const AuthStatus_Unverified({this.lastUserJson}): super._();
  

 final  String? lastUserJson;

/// Create a copy of AuthStatus
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$AuthStatus_UnverifiedCopyWith<AuthStatus_Unverified> get copyWith => _$AuthStatus_UnverifiedCopyWithImpl<AuthStatus_Unverified>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is AuthStatus_Unverified&&(identical(other.lastUserJson, lastUserJson) || other.lastUserJson == lastUserJson));
}


@override
int get hashCode => Object.hash(runtimeType,lastUserJson);

@override
String toString() {
  return 'AuthStatus.unverified(lastUserJson: $lastUserJson)';
}


}

/// @nodoc
abstract mixin class $AuthStatus_UnverifiedCopyWith<$Res> implements $AuthStatusCopyWith<$Res> {
  factory $AuthStatus_UnverifiedCopyWith(AuthStatus_Unverified value, $Res Function(AuthStatus_Unverified) _then) = _$AuthStatus_UnverifiedCopyWithImpl;
@useResult
$Res call({
 String? lastUserJson
});




}
/// @nodoc
class _$AuthStatus_UnverifiedCopyWithImpl<$Res>
    implements $AuthStatus_UnverifiedCopyWith<$Res> {
  _$AuthStatus_UnverifiedCopyWithImpl(this._self, this._then);

  final AuthStatus_Unverified _self;
  final $Res Function(AuthStatus_Unverified) _then;

/// Create a copy of AuthStatus
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? lastUserJson = freezed,}) {
  return _then(AuthStatus_Unverified(
lastUserJson: freezed == lastUserJson ? _self.lastUserJson : lastUserJson // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}

/// @nodoc


class AuthStatus_SignedOut extends AuthStatus {
  const AuthStatus_SignedOut(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is AuthStatus_SignedOut);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'AuthStatus.signedOut()';
}


}




/// @nodoc
mixin _$SignInStep {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SignInStep);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'SignInStep()';
}


}

/// @nodoc
class $SignInStepCopyWith<$Res>  {
$SignInStepCopyWith(SignInStep _, $Res Function(SignInStep) __);
}


/// Adds pattern-matching-related methods to [SignInStep].
extension SignInStepPatterns on SignInStep {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( SignInStep_SignedIn value)?  signedIn,TResult Function( SignInStep_TwoFactorRequired value)?  twoFactorRequired,TResult Function( SignInStep_VerificationRequired value)?  verificationRequired,TResult Function( SignInStep_Cancelled value)?  cancelled,required TResult orElse(),}){
final _that = this;
switch (_that) {
case SignInStep_SignedIn() when signedIn != null:
return signedIn(_that);case SignInStep_TwoFactorRequired() when twoFactorRequired != null:
return twoFactorRequired(_that);case SignInStep_VerificationRequired() when verificationRequired != null:
return verificationRequired(_that);case SignInStep_Cancelled() when cancelled != null:
return cancelled(_that);case _:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( SignInStep_SignedIn value)  signedIn,required TResult Function( SignInStep_TwoFactorRequired value)  twoFactorRequired,required TResult Function( SignInStep_VerificationRequired value)  verificationRequired,required TResult Function( SignInStep_Cancelled value)  cancelled,}){
final _that = this;
switch (_that) {
case SignInStep_SignedIn():
return signedIn(_that);case SignInStep_TwoFactorRequired():
return twoFactorRequired(_that);case SignInStep_VerificationRequired():
return verificationRequired(_that);case SignInStep_Cancelled():
return cancelled(_that);}
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( SignInStep_SignedIn value)?  signedIn,TResult? Function( SignInStep_TwoFactorRequired value)?  twoFactorRequired,TResult? Function( SignInStep_VerificationRequired value)?  verificationRequired,TResult? Function( SignInStep_Cancelled value)?  cancelled,}){
final _that = this;
switch (_that) {
case SignInStep_SignedIn() when signedIn != null:
return signedIn(_that);case SignInStep_TwoFactorRequired() when twoFactorRequired != null:
return twoFactorRequired(_that);case SignInStep_VerificationRequired() when verificationRequired != null:
return verificationRequired(_that);case SignInStep_Cancelled() when cancelled != null:
return cancelled(_that);case _:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( SignedInView field0)?  signedIn,TResult Function( String challenge)?  twoFactorRequired,TResult Function()?  verificationRequired,TResult Function()?  cancelled,required TResult orElse(),}) {final _that = this;
switch (_that) {
case SignInStep_SignedIn() when signedIn != null:
return signedIn(_that.field0);case SignInStep_TwoFactorRequired() when twoFactorRequired != null:
return twoFactorRequired(_that.challenge);case SignInStep_VerificationRequired() when verificationRequired != null:
return verificationRequired();case SignInStep_Cancelled() when cancelled != null:
return cancelled();case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( SignedInView field0)  signedIn,required TResult Function( String challenge)  twoFactorRequired,required TResult Function()  verificationRequired,required TResult Function()  cancelled,}) {final _that = this;
switch (_that) {
case SignInStep_SignedIn():
return signedIn(_that.field0);case SignInStep_TwoFactorRequired():
return twoFactorRequired(_that.challenge);case SignInStep_VerificationRequired():
return verificationRequired();case SignInStep_Cancelled():
return cancelled();}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( SignedInView field0)?  signedIn,TResult? Function( String challenge)?  twoFactorRequired,TResult? Function()?  verificationRequired,TResult? Function()?  cancelled,}) {final _that = this;
switch (_that) {
case SignInStep_SignedIn() when signedIn != null:
return signedIn(_that.field0);case SignInStep_TwoFactorRequired() when twoFactorRequired != null:
return twoFactorRequired(_that.challenge);case SignInStep_VerificationRequired() when verificationRequired != null:
return verificationRequired();case SignInStep_Cancelled() when cancelled != null:
return cancelled();case _:
  return null;

}
}

}

/// @nodoc


class SignInStep_SignedIn extends SignInStep {
  const SignInStep_SignedIn(this.field0): super._();
  

 final  SignedInView field0;

/// Create a copy of SignInStep
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$SignInStep_SignedInCopyWith<SignInStep_SignedIn> get copyWith => _$SignInStep_SignedInCopyWithImpl<SignInStep_SignedIn>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SignInStep_SignedIn&&(identical(other.field0, field0) || other.field0 == field0));
}


@override
int get hashCode => Object.hash(runtimeType,field0);

@override
String toString() {
  return 'SignInStep.signedIn(field0: $field0)';
}


}

/// @nodoc
abstract mixin class $SignInStep_SignedInCopyWith<$Res> implements $SignInStepCopyWith<$Res> {
  factory $SignInStep_SignedInCopyWith(SignInStep_SignedIn value, $Res Function(SignInStep_SignedIn) _then) = _$SignInStep_SignedInCopyWithImpl;
@useResult
$Res call({
 SignedInView field0
});




}
/// @nodoc
class _$SignInStep_SignedInCopyWithImpl<$Res>
    implements $SignInStep_SignedInCopyWith<$Res> {
  _$SignInStep_SignedInCopyWithImpl(this._self, this._then);

  final SignInStep_SignedIn _self;
  final $Res Function(SignInStep_SignedIn) _then;

/// Create a copy of SignInStep
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? field0 = null,}) {
  return _then(SignInStep_SignedIn(
null == field0 ? _self.field0 : field0 // ignore: cast_nullable_to_non_nullable
as SignedInView,
  ));
}


}

/// @nodoc


class SignInStep_TwoFactorRequired extends SignInStep {
  const SignInStep_TwoFactorRequired({required this.challenge}): super._();
  

 final  String challenge;

/// Create a copy of SignInStep
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$SignInStep_TwoFactorRequiredCopyWith<SignInStep_TwoFactorRequired> get copyWith => _$SignInStep_TwoFactorRequiredCopyWithImpl<SignInStep_TwoFactorRequired>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SignInStep_TwoFactorRequired&&(identical(other.challenge, challenge) || other.challenge == challenge));
}


@override
int get hashCode => Object.hash(runtimeType,challenge);

@override
String toString() {
  return 'SignInStep.twoFactorRequired(challenge: $challenge)';
}


}

/// @nodoc
abstract mixin class $SignInStep_TwoFactorRequiredCopyWith<$Res> implements $SignInStepCopyWith<$Res> {
  factory $SignInStep_TwoFactorRequiredCopyWith(SignInStep_TwoFactorRequired value, $Res Function(SignInStep_TwoFactorRequired) _then) = _$SignInStep_TwoFactorRequiredCopyWithImpl;
@useResult
$Res call({
 String challenge
});




}
/// @nodoc
class _$SignInStep_TwoFactorRequiredCopyWithImpl<$Res>
    implements $SignInStep_TwoFactorRequiredCopyWith<$Res> {
  _$SignInStep_TwoFactorRequiredCopyWithImpl(this._self, this._then);

  final SignInStep_TwoFactorRequired _self;
  final $Res Function(SignInStep_TwoFactorRequired) _then;

/// Create a copy of SignInStep
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? challenge = null,}) {
  return _then(SignInStep_TwoFactorRequired(
challenge: null == challenge ? _self.challenge : challenge // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class SignInStep_VerificationRequired extends SignInStep {
  const SignInStep_VerificationRequired(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SignInStep_VerificationRequired);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'SignInStep.verificationRequired()';
}


}




/// @nodoc


class SignInStep_Cancelled extends SignInStep {
  const SignInStep_Cancelled(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SignInStep_Cancelled);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'SignInStep.cancelled()';
}


}




// dart format on
