// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'files.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;
/// @nodoc
mixin _$FileBytesOutcome {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is FileBytesOutcome);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'FileBytesOutcome()';
}


}

/// @nodoc
class $FileBytesOutcomeCopyWith<$Res>  {
$FileBytesOutcomeCopyWith(FileBytesOutcome _, $Res Function(FileBytesOutcome) __);
}


/// Adds pattern-matching-related methods to [FileBytesOutcome].
extension FileBytesOutcomePatterns on FileBytesOutcome {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( FileBytesOutcome_Bytes value)?  bytes,TResult Function( FileBytesOutcome_Problem value)?  problem,required TResult orElse(),}){
final _that = this;
switch (_that) {
case FileBytesOutcome_Bytes() when bytes != null:
return bytes(_that);case FileBytesOutcome_Problem() when problem != null:
return problem(_that);case _:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( FileBytesOutcome_Bytes value)  bytes,required TResult Function( FileBytesOutcome_Problem value)  problem,}){
final _that = this;
switch (_that) {
case FileBytesOutcome_Bytes():
return bytes(_that);case FileBytesOutcome_Problem():
return problem(_that);}
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( FileBytesOutcome_Bytes value)?  bytes,TResult? Function( FileBytesOutcome_Problem value)?  problem,}){
final _that = this;
switch (_that) {
case FileBytesOutcome_Bytes() when bytes != null:
return bytes(_that);case FileBytesOutcome_Problem() when problem != null:
return problem(_that);case _:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( Uint8List bytes)?  bytes,TResult Function( FileProblem problem)?  problem,required TResult orElse(),}) {final _that = this;
switch (_that) {
case FileBytesOutcome_Bytes() when bytes != null:
return bytes(_that.bytes);case FileBytesOutcome_Problem() when problem != null:
return problem(_that.problem);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( Uint8List bytes)  bytes,required TResult Function( FileProblem problem)  problem,}) {final _that = this;
switch (_that) {
case FileBytesOutcome_Bytes():
return bytes(_that.bytes);case FileBytesOutcome_Problem():
return problem(_that.problem);}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( Uint8List bytes)?  bytes,TResult? Function( FileProblem problem)?  problem,}) {final _that = this;
switch (_that) {
case FileBytesOutcome_Bytes() when bytes != null:
return bytes(_that.bytes);case FileBytesOutcome_Problem() when problem != null:
return problem(_that.problem);case _:
  return null;

}
}

}

/// @nodoc


class FileBytesOutcome_Bytes extends FileBytesOutcome {
  const FileBytesOutcome_Bytes({required this.bytes}): super._();
  

 final  Uint8List bytes;

/// Create a copy of FileBytesOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$FileBytesOutcome_BytesCopyWith<FileBytesOutcome_Bytes> get copyWith => _$FileBytesOutcome_BytesCopyWithImpl<FileBytesOutcome_Bytes>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is FileBytesOutcome_Bytes&&const DeepCollectionEquality().equals(other.bytes, bytes));
}


@override
int get hashCode => Object.hash(runtimeType,const DeepCollectionEquality().hash(bytes));

@override
String toString() {
  return 'FileBytesOutcome.bytes(bytes: $bytes)';
}


}

/// @nodoc
abstract mixin class $FileBytesOutcome_BytesCopyWith<$Res> implements $FileBytesOutcomeCopyWith<$Res> {
  factory $FileBytesOutcome_BytesCopyWith(FileBytesOutcome_Bytes value, $Res Function(FileBytesOutcome_Bytes) _then) = _$FileBytesOutcome_BytesCopyWithImpl;
@useResult
$Res call({
 Uint8List bytes
});




}
/// @nodoc
class _$FileBytesOutcome_BytesCopyWithImpl<$Res>
    implements $FileBytesOutcome_BytesCopyWith<$Res> {
  _$FileBytesOutcome_BytesCopyWithImpl(this._self, this._then);

  final FileBytesOutcome_Bytes _self;
  final $Res Function(FileBytesOutcome_Bytes) _then;

/// Create a copy of FileBytesOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? bytes = null,}) {
  return _then(FileBytesOutcome_Bytes(
bytes: null == bytes ? _self.bytes : bytes // ignore: cast_nullable_to_non_nullable
as Uint8List,
  ));
}


}

/// @nodoc


class FileBytesOutcome_Problem extends FileBytesOutcome {
  const FileBytesOutcome_Problem({required this.problem}): super._();
  

 final  FileProblem problem;

/// Create a copy of FileBytesOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$FileBytesOutcome_ProblemCopyWith<FileBytesOutcome_Problem> get copyWith => _$FileBytesOutcome_ProblemCopyWithImpl<FileBytesOutcome_Problem>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is FileBytesOutcome_Problem&&(identical(other.problem, problem) || other.problem == problem));
}


@override
int get hashCode => Object.hash(runtimeType,problem);

@override
String toString() {
  return 'FileBytesOutcome.problem(problem: $problem)';
}


}

/// @nodoc
abstract mixin class $FileBytesOutcome_ProblemCopyWith<$Res> implements $FileBytesOutcomeCopyWith<$Res> {
  factory $FileBytesOutcome_ProblemCopyWith(FileBytesOutcome_Problem value, $Res Function(FileBytesOutcome_Problem) _then) = _$FileBytesOutcome_ProblemCopyWithImpl;
@useResult
$Res call({
 FileProblem problem
});




}
/// @nodoc
class _$FileBytesOutcome_ProblemCopyWithImpl<$Res>
    implements $FileBytesOutcome_ProblemCopyWith<$Res> {
  _$FileBytesOutcome_ProblemCopyWithImpl(this._self, this._then);

  final FileBytesOutcome_Problem _self;
  final $Res Function(FileBytesOutcome_Problem) _then;

/// Create a copy of FileBytesOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? problem = null,}) {
  return _then(FileBytesOutcome_Problem(
problem: null == problem ? _self.problem : problem // ignore: cast_nullable_to_non_nullable
as FileProblem,
  ));
}


}

/// @nodoc
mixin _$FileTextOutcome {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is FileTextOutcome);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'FileTextOutcome()';
}


}

/// @nodoc
class $FileTextOutcomeCopyWith<$Res>  {
$FileTextOutcomeCopyWith(FileTextOutcome _, $Res Function(FileTextOutcome) __);
}


/// Adds pattern-matching-related methods to [FileTextOutcome].
extension FileTextOutcomePatterns on FileTextOutcome {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( FileTextOutcome_Text value)?  text,TResult Function( FileTextOutcome_Problem value)?  problem,required TResult orElse(),}){
final _that = this;
switch (_that) {
case FileTextOutcome_Text() when text != null:
return text(_that);case FileTextOutcome_Problem() when problem != null:
return problem(_that);case _:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( FileTextOutcome_Text value)  text,required TResult Function( FileTextOutcome_Problem value)  problem,}){
final _that = this;
switch (_that) {
case FileTextOutcome_Text():
return text(_that);case FileTextOutcome_Problem():
return problem(_that);}
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( FileTextOutcome_Text value)?  text,TResult? Function( FileTextOutcome_Problem value)?  problem,}){
final _that = this;
switch (_that) {
case FileTextOutcome_Text() when text != null:
return text(_that);case FileTextOutcome_Problem() when problem != null:
return problem(_that);case _:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( String contents,  bool truncated)?  text,TResult Function( FileProblem problem)?  problem,required TResult orElse(),}) {final _that = this;
switch (_that) {
case FileTextOutcome_Text() when text != null:
return text(_that.contents,_that.truncated);case FileTextOutcome_Problem() when problem != null:
return problem(_that.problem);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( String contents,  bool truncated)  text,required TResult Function( FileProblem problem)  problem,}) {final _that = this;
switch (_that) {
case FileTextOutcome_Text():
return text(_that.contents,_that.truncated);case FileTextOutcome_Problem():
return problem(_that.problem);}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( String contents,  bool truncated)?  text,TResult? Function( FileProblem problem)?  problem,}) {final _that = this;
switch (_that) {
case FileTextOutcome_Text() when text != null:
return text(_that.contents,_that.truncated);case FileTextOutcome_Problem() when problem != null:
return problem(_that.problem);case _:
  return null;

}
}

}

/// @nodoc


class FileTextOutcome_Text extends FileTextOutcome {
  const FileTextOutcome_Text({required this.contents, required this.truncated}): super._();
  

 final  String contents;
 final  bool truncated;

/// Create a copy of FileTextOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$FileTextOutcome_TextCopyWith<FileTextOutcome_Text> get copyWith => _$FileTextOutcome_TextCopyWithImpl<FileTextOutcome_Text>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is FileTextOutcome_Text&&(identical(other.contents, contents) || other.contents == contents)&&(identical(other.truncated, truncated) || other.truncated == truncated));
}


@override
int get hashCode => Object.hash(runtimeType,contents,truncated);

@override
String toString() {
  return 'FileTextOutcome.text(contents: $contents, truncated: $truncated)';
}


}

/// @nodoc
abstract mixin class $FileTextOutcome_TextCopyWith<$Res> implements $FileTextOutcomeCopyWith<$Res> {
  factory $FileTextOutcome_TextCopyWith(FileTextOutcome_Text value, $Res Function(FileTextOutcome_Text) _then) = _$FileTextOutcome_TextCopyWithImpl;
@useResult
$Res call({
 String contents, bool truncated
});




}
/// @nodoc
class _$FileTextOutcome_TextCopyWithImpl<$Res>
    implements $FileTextOutcome_TextCopyWith<$Res> {
  _$FileTextOutcome_TextCopyWithImpl(this._self, this._then);

  final FileTextOutcome_Text _self;
  final $Res Function(FileTextOutcome_Text) _then;

/// Create a copy of FileTextOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? contents = null,Object? truncated = null,}) {
  return _then(FileTextOutcome_Text(
contents: null == contents ? _self.contents : contents // ignore: cast_nullable_to_non_nullable
as String,truncated: null == truncated ? _self.truncated : truncated // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class FileTextOutcome_Problem extends FileTextOutcome {
  const FileTextOutcome_Problem({required this.problem}): super._();
  

 final  FileProblem problem;

/// Create a copy of FileTextOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$FileTextOutcome_ProblemCopyWith<FileTextOutcome_Problem> get copyWith => _$FileTextOutcome_ProblemCopyWithImpl<FileTextOutcome_Problem>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is FileTextOutcome_Problem&&(identical(other.problem, problem) || other.problem == problem));
}


@override
int get hashCode => Object.hash(runtimeType,problem);

@override
String toString() {
  return 'FileTextOutcome.problem(problem: $problem)';
}


}

/// @nodoc
abstract mixin class $FileTextOutcome_ProblemCopyWith<$Res> implements $FileTextOutcomeCopyWith<$Res> {
  factory $FileTextOutcome_ProblemCopyWith(FileTextOutcome_Problem value, $Res Function(FileTextOutcome_Problem) _then) = _$FileTextOutcome_ProblemCopyWithImpl;
@useResult
$Res call({
 FileProblem problem
});




}
/// @nodoc
class _$FileTextOutcome_ProblemCopyWithImpl<$Res>
    implements $FileTextOutcome_ProblemCopyWith<$Res> {
  _$FileTextOutcome_ProblemCopyWithImpl(this._self, this._then);

  final FileTextOutcome_Problem _self;
  final $Res Function(FileTextOutcome_Problem) _then;

/// Create a copy of FileTextOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? problem = null,}) {
  return _then(FileTextOutcome_Problem(
problem: null == problem ? _self.problem : problem // ignore: cast_nullable_to_non_nullable
as FileProblem,
  ));
}


}

/// @nodoc
mixin _$LocateOutcome {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is LocateOutcome);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'LocateOutcome()';
}


}

/// @nodoc
class $LocateOutcomeCopyWith<$Res>  {
$LocateOutcomeCopyWith(LocateOutcome _, $Res Function(LocateOutcome) __);
}


/// Adds pattern-matching-related methods to [LocateOutcome].
extension LocateOutcomePatterns on LocateOutcome {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( LocateOutcome_Located value)?  located,TResult Function( LocateOutcome_Outside value)?  outside,TResult Function( LocateOutcome_Failed value)?  failed,required TResult orElse(),}){
final _that = this;
switch (_that) {
case LocateOutcome_Located() when located != null:
return located(_that);case LocateOutcome_Outside() when outside != null:
return outside(_that);case LocateOutcome_Failed() when failed != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( LocateOutcome_Located value)  located,required TResult Function( LocateOutcome_Outside value)  outside,required TResult Function( LocateOutcome_Failed value)  failed,}){
final _that = this;
switch (_that) {
case LocateOutcome_Located():
return located(_that);case LocateOutcome_Outside():
return outside(_that);case LocateOutcome_Failed():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( LocateOutcome_Located value)?  located,TResult? Function( LocateOutcome_Outside value)?  outside,TResult? Function( LocateOutcome_Failed value)?  failed,}){
final _that = this;
switch (_that) {
case LocateOutcome_Located() when located != null:
return located(_that);case LocateOutcome_Outside() when outside != null:
return outside(_that);case LocateOutcome_Failed() when failed != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( FileLocationView location)?  located,TResult Function()?  outside,TResult Function()?  failed,required TResult orElse(),}) {final _that = this;
switch (_that) {
case LocateOutcome_Located() when located != null:
return located(_that.location);case LocateOutcome_Outside() when outside != null:
return outside();case LocateOutcome_Failed() when failed != null:
return failed();case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( FileLocationView location)  located,required TResult Function()  outside,required TResult Function()  failed,}) {final _that = this;
switch (_that) {
case LocateOutcome_Located():
return located(_that.location);case LocateOutcome_Outside():
return outside();case LocateOutcome_Failed():
return failed();}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( FileLocationView location)?  located,TResult? Function()?  outside,TResult? Function()?  failed,}) {final _that = this;
switch (_that) {
case LocateOutcome_Located() when located != null:
return located(_that.location);case LocateOutcome_Outside() when outside != null:
return outside();case LocateOutcome_Failed() when failed != null:
return failed();case _:
  return null;

}
}

}

/// @nodoc


class LocateOutcome_Located extends LocateOutcome {
  const LocateOutcome_Located({required this.location}): super._();
  

 final  FileLocationView location;

/// Create a copy of LocateOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$LocateOutcome_LocatedCopyWith<LocateOutcome_Located> get copyWith => _$LocateOutcome_LocatedCopyWithImpl<LocateOutcome_Located>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is LocateOutcome_Located&&(identical(other.location, location) || other.location == location));
}


@override
int get hashCode => Object.hash(runtimeType,location);

@override
String toString() {
  return 'LocateOutcome.located(location: $location)';
}


}

/// @nodoc
abstract mixin class $LocateOutcome_LocatedCopyWith<$Res> implements $LocateOutcomeCopyWith<$Res> {
  factory $LocateOutcome_LocatedCopyWith(LocateOutcome_Located value, $Res Function(LocateOutcome_Located) _then) = _$LocateOutcome_LocatedCopyWithImpl;
@useResult
$Res call({
 FileLocationView location
});




}
/// @nodoc
class _$LocateOutcome_LocatedCopyWithImpl<$Res>
    implements $LocateOutcome_LocatedCopyWith<$Res> {
  _$LocateOutcome_LocatedCopyWithImpl(this._self, this._then);

  final LocateOutcome_Located _self;
  final $Res Function(LocateOutcome_Located) _then;

/// Create a copy of LocateOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? location = null,}) {
  return _then(LocateOutcome_Located(
location: null == location ? _self.location : location // ignore: cast_nullable_to_non_nullable
as FileLocationView,
  ));
}


}

/// @nodoc


class LocateOutcome_Outside extends LocateOutcome {
  const LocateOutcome_Outside(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is LocateOutcome_Outside);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'LocateOutcome.outside()';
}


}




/// @nodoc


class LocateOutcome_Failed extends LocateOutcome {
  const LocateOutcome_Failed(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is LocateOutcome_Failed);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'LocateOutcome.failed()';
}


}




// dart format on
