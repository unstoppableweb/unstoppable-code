// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'projects.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;
/// @nodoc
mixin _$ProjectsIntent {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ProjectsIntent);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'ProjectsIntent()';
}


}

/// @nodoc
class $ProjectsIntentCopyWith<$Res>  {
$ProjectsIntentCopyWith(ProjectsIntent _, $Res Function(ProjectsIntent) __);
}


/// Adds pattern-matching-related methods to [ProjectsIntent].
extension ProjectsIntentPatterns on ProjectsIntent {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( ProjectsIntent_Discover value)?  discover,TResult Function( ProjectsIntent_Commit value)?  commit,TResult Function( ProjectsIntent_ReadBack value)?  readBack,TResult Function( ProjectsIntent_Acknowledge value)?  acknowledge,TResult Function( ProjectsIntent_Dismiss value)?  dismiss,TResult Function( ProjectsIntent_Retire value)?  retire,TResult Function( ProjectsIntent_Close value)?  close,required TResult orElse(),}){
final _that = this;
switch (_that) {
case ProjectsIntent_Discover() when discover != null:
return discover(_that);case ProjectsIntent_Commit() when commit != null:
return commit(_that);case ProjectsIntent_ReadBack() when readBack != null:
return readBack(_that);case ProjectsIntent_Acknowledge() when acknowledge != null:
return acknowledge(_that);case ProjectsIntent_Dismiss() when dismiss != null:
return dismiss(_that);case ProjectsIntent_Retire() when retire != null:
return retire(_that);case ProjectsIntent_Close() when close != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( ProjectsIntent_Discover value)  discover,required TResult Function( ProjectsIntent_Commit value)  commit,required TResult Function( ProjectsIntent_ReadBack value)  readBack,required TResult Function( ProjectsIntent_Acknowledge value)  acknowledge,required TResult Function( ProjectsIntent_Dismiss value)  dismiss,required TResult Function( ProjectsIntent_Retire value)  retire,required TResult Function( ProjectsIntent_Close value)  close,}){
final _that = this;
switch (_that) {
case ProjectsIntent_Discover():
return discover(_that);case ProjectsIntent_Commit():
return commit(_that);case ProjectsIntent_ReadBack():
return readBack(_that);case ProjectsIntent_Acknowledge():
return acknowledge(_that);case ProjectsIntent_Dismiss():
return dismiss(_that);case ProjectsIntent_Retire():
return retire(_that);case ProjectsIntent_Close():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( ProjectsIntent_Discover value)?  discover,TResult? Function( ProjectsIntent_Commit value)?  commit,TResult? Function( ProjectsIntent_ReadBack value)?  readBack,TResult? Function( ProjectsIntent_Acknowledge value)?  acknowledge,TResult? Function( ProjectsIntent_Dismiss value)?  dismiss,TResult? Function( ProjectsIntent_Retire value)?  retire,TResult? Function( ProjectsIntent_Close value)?  close,}){
final _that = this;
switch (_that) {
case ProjectsIntent_Discover() when discover != null:
return discover(_that);case ProjectsIntent_Commit() when commit != null:
return commit(_that);case ProjectsIntent_ReadBack() when readBack != null:
return readBack(_that);case ProjectsIntent_Acknowledge() when acknowledge != null:
return acknowledge(_that);case ProjectsIntent_Dismiss() when dismiss != null:
return dismiss(_that);case ProjectsIntent_Retire() when retire != null:
return retire(_that);case ProjectsIntent_Close() when close != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function()?  discover,TResult Function( int discovery,  String url,  bool allowed)?  commit,TResult Function()?  readBack,TResult Function( String jobId)?  acknowledge,TResult Function( String jobId)?  dismiss,TResult Function( List<String> projectIds)?  retire,TResult Function()?  close,required TResult orElse(),}) {final _that = this;
switch (_that) {
case ProjectsIntent_Discover() when discover != null:
return discover();case ProjectsIntent_Commit() when commit != null:
return commit(_that.discovery,_that.url,_that.allowed);case ProjectsIntent_ReadBack() when readBack != null:
return readBack();case ProjectsIntent_Acknowledge() when acknowledge != null:
return acknowledge(_that.jobId);case ProjectsIntent_Dismiss() when dismiss != null:
return dismiss(_that.jobId);case ProjectsIntent_Retire() when retire != null:
return retire(_that.projectIds);case ProjectsIntent_Close() when close != null:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function()  discover,required TResult Function( int discovery,  String url,  bool allowed)  commit,required TResult Function()  readBack,required TResult Function( String jobId)  acknowledge,required TResult Function( String jobId)  dismiss,required TResult Function( List<String> projectIds)  retire,required TResult Function()  close,}) {final _that = this;
switch (_that) {
case ProjectsIntent_Discover():
return discover();case ProjectsIntent_Commit():
return commit(_that.discovery,_that.url,_that.allowed);case ProjectsIntent_ReadBack():
return readBack();case ProjectsIntent_Acknowledge():
return acknowledge(_that.jobId);case ProjectsIntent_Dismiss():
return dismiss(_that.jobId);case ProjectsIntent_Retire():
return retire(_that.projectIds);case ProjectsIntent_Close():
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function()?  discover,TResult? Function( int discovery,  String url,  bool allowed)?  commit,TResult? Function()?  readBack,TResult? Function( String jobId)?  acknowledge,TResult? Function( String jobId)?  dismiss,TResult? Function( List<String> projectIds)?  retire,TResult? Function()?  close,}) {final _that = this;
switch (_that) {
case ProjectsIntent_Discover() when discover != null:
return discover();case ProjectsIntent_Commit() when commit != null:
return commit(_that.discovery,_that.url,_that.allowed);case ProjectsIntent_ReadBack() when readBack != null:
return readBack();case ProjectsIntent_Acknowledge() when acknowledge != null:
return acknowledge(_that.jobId);case ProjectsIntent_Dismiss() when dismiss != null:
return dismiss(_that.jobId);case ProjectsIntent_Retire() when retire != null:
return retire(_that.projectIds);case ProjectsIntent_Close() when close != null:
return close();case _:
  return null;

}
}

}

/// @nodoc


class ProjectsIntent_Discover extends ProjectsIntent {
  const ProjectsIntent_Discover(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ProjectsIntent_Discover);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'ProjectsIntent.discover()';
}


}




/// @nodoc


class ProjectsIntent_Commit extends ProjectsIntent {
  const ProjectsIntent_Commit({required this.discovery, required this.url, required this.allowed}): super._();
  

 final  int discovery;
 final  String url;
 final  bool allowed;

/// Create a copy of ProjectsIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ProjectsIntent_CommitCopyWith<ProjectsIntent_Commit> get copyWith => _$ProjectsIntent_CommitCopyWithImpl<ProjectsIntent_Commit>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ProjectsIntent_Commit&&(identical(other.discovery, discovery) || other.discovery == discovery)&&(identical(other.url, url) || other.url == url)&&(identical(other.allowed, allowed) || other.allowed == allowed));
}


@override
int get hashCode => Object.hash(runtimeType,discovery,url,allowed);

@override
String toString() {
  return 'ProjectsIntent.commit(discovery: $discovery, url: $url, allowed: $allowed)';
}


}

/// @nodoc
abstract mixin class $ProjectsIntent_CommitCopyWith<$Res> implements $ProjectsIntentCopyWith<$Res> {
  factory $ProjectsIntent_CommitCopyWith(ProjectsIntent_Commit value, $Res Function(ProjectsIntent_Commit) _then) = _$ProjectsIntent_CommitCopyWithImpl;
@useResult
$Res call({
 int discovery, String url, bool allowed
});




}
/// @nodoc
class _$ProjectsIntent_CommitCopyWithImpl<$Res>
    implements $ProjectsIntent_CommitCopyWith<$Res> {
  _$ProjectsIntent_CommitCopyWithImpl(this._self, this._then);

  final ProjectsIntent_Commit _self;
  final $Res Function(ProjectsIntent_Commit) _then;

/// Create a copy of ProjectsIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? discovery = null,Object? url = null,Object? allowed = null,}) {
  return _then(ProjectsIntent_Commit(
discovery: null == discovery ? _self.discovery : discovery // ignore: cast_nullable_to_non_nullable
as int,url: null == url ? _self.url : url // ignore: cast_nullable_to_non_nullable
as String,allowed: null == allowed ? _self.allowed : allowed // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class ProjectsIntent_ReadBack extends ProjectsIntent {
  const ProjectsIntent_ReadBack(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ProjectsIntent_ReadBack);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'ProjectsIntent.readBack()';
}


}




/// @nodoc


class ProjectsIntent_Acknowledge extends ProjectsIntent {
  const ProjectsIntent_Acknowledge({required this.jobId}): super._();
  

 final  String jobId;

/// Create a copy of ProjectsIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ProjectsIntent_AcknowledgeCopyWith<ProjectsIntent_Acknowledge> get copyWith => _$ProjectsIntent_AcknowledgeCopyWithImpl<ProjectsIntent_Acknowledge>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ProjectsIntent_Acknowledge&&(identical(other.jobId, jobId) || other.jobId == jobId));
}


@override
int get hashCode => Object.hash(runtimeType,jobId);

@override
String toString() {
  return 'ProjectsIntent.acknowledge(jobId: $jobId)';
}


}

/// @nodoc
abstract mixin class $ProjectsIntent_AcknowledgeCopyWith<$Res> implements $ProjectsIntentCopyWith<$Res> {
  factory $ProjectsIntent_AcknowledgeCopyWith(ProjectsIntent_Acknowledge value, $Res Function(ProjectsIntent_Acknowledge) _then) = _$ProjectsIntent_AcknowledgeCopyWithImpl;
@useResult
$Res call({
 String jobId
});




}
/// @nodoc
class _$ProjectsIntent_AcknowledgeCopyWithImpl<$Res>
    implements $ProjectsIntent_AcknowledgeCopyWith<$Res> {
  _$ProjectsIntent_AcknowledgeCopyWithImpl(this._self, this._then);

  final ProjectsIntent_Acknowledge _self;
  final $Res Function(ProjectsIntent_Acknowledge) _then;

/// Create a copy of ProjectsIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? jobId = null,}) {
  return _then(ProjectsIntent_Acknowledge(
jobId: null == jobId ? _self.jobId : jobId // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class ProjectsIntent_Dismiss extends ProjectsIntent {
  const ProjectsIntent_Dismiss({required this.jobId}): super._();
  

 final  String jobId;

/// Create a copy of ProjectsIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ProjectsIntent_DismissCopyWith<ProjectsIntent_Dismiss> get copyWith => _$ProjectsIntent_DismissCopyWithImpl<ProjectsIntent_Dismiss>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ProjectsIntent_Dismiss&&(identical(other.jobId, jobId) || other.jobId == jobId));
}


@override
int get hashCode => Object.hash(runtimeType,jobId);

@override
String toString() {
  return 'ProjectsIntent.dismiss(jobId: $jobId)';
}


}

/// @nodoc
abstract mixin class $ProjectsIntent_DismissCopyWith<$Res> implements $ProjectsIntentCopyWith<$Res> {
  factory $ProjectsIntent_DismissCopyWith(ProjectsIntent_Dismiss value, $Res Function(ProjectsIntent_Dismiss) _then) = _$ProjectsIntent_DismissCopyWithImpl;
@useResult
$Res call({
 String jobId
});




}
/// @nodoc
class _$ProjectsIntent_DismissCopyWithImpl<$Res>
    implements $ProjectsIntent_DismissCopyWith<$Res> {
  _$ProjectsIntent_DismissCopyWithImpl(this._self, this._then);

  final ProjectsIntent_Dismiss _self;
  final $Res Function(ProjectsIntent_Dismiss) _then;

/// Create a copy of ProjectsIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? jobId = null,}) {
  return _then(ProjectsIntent_Dismiss(
jobId: null == jobId ? _self.jobId : jobId // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class ProjectsIntent_Retire extends ProjectsIntent {
  const ProjectsIntent_Retire({required final  List<String> projectIds}): _projectIds = projectIds,super._();
  

 final  List<String> _projectIds;
 List<String> get projectIds {
  if (_projectIds is EqualUnmodifiableListView) return _projectIds;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_projectIds);
}


/// Create a copy of ProjectsIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ProjectsIntent_RetireCopyWith<ProjectsIntent_Retire> get copyWith => _$ProjectsIntent_RetireCopyWithImpl<ProjectsIntent_Retire>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ProjectsIntent_Retire&&const DeepCollectionEquality().equals(other._projectIds, _projectIds));
}


@override
int get hashCode => Object.hash(runtimeType,const DeepCollectionEquality().hash(_projectIds));

@override
String toString() {
  return 'ProjectsIntent.retire(projectIds: $projectIds)';
}


}

/// @nodoc
abstract mixin class $ProjectsIntent_RetireCopyWith<$Res> implements $ProjectsIntentCopyWith<$Res> {
  factory $ProjectsIntent_RetireCopyWith(ProjectsIntent_Retire value, $Res Function(ProjectsIntent_Retire) _then) = _$ProjectsIntent_RetireCopyWithImpl;
@useResult
$Res call({
 List<String> projectIds
});




}
/// @nodoc
class _$ProjectsIntent_RetireCopyWithImpl<$Res>
    implements $ProjectsIntent_RetireCopyWith<$Res> {
  _$ProjectsIntent_RetireCopyWithImpl(this._self, this._then);

  final ProjectsIntent_Retire _self;
  final $Res Function(ProjectsIntent_Retire) _then;

/// Create a copy of ProjectsIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? projectIds = null,}) {
  return _then(ProjectsIntent_Retire(
projectIds: null == projectIds ? _self._projectIds : projectIds // ignore: cast_nullable_to_non_nullable
as List<String>,
  ));
}


}

/// @nodoc


class ProjectsIntent_Close extends ProjectsIntent {
  const ProjectsIntent_Close(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ProjectsIntent_Close);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'ProjectsIntent.close()';
}


}




/// @nodoc
mixin _$ProjectsOutcome {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ProjectsOutcome);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'ProjectsOutcome()';
}


}

/// @nodoc
class $ProjectsOutcomeCopyWith<$Res>  {
$ProjectsOutcomeCopyWith(ProjectsOutcome _, $Res Function(ProjectsOutcome) __);
}


/// Adds pattern-matching-related methods to [ProjectsOutcome].
extension ProjectsOutcomePatterns on ProjectsOutcome {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( ProjectsOutcome_Refused value)?  refused,TResult Function( ProjectsOutcome_Discovered value)?  discovered,TResult Function( ProjectsOutcome_Started value)?  started,TResult Function( ProjectsOutcome_Acknowledged value)?  acknowledged,TResult Function( ProjectsOutcome_Done value)?  done,TResult Function( ProjectsOutcome_Failed value)?  failed,required TResult orElse(),}){
final _that = this;
switch (_that) {
case ProjectsOutcome_Refused() when refused != null:
return refused(_that);case ProjectsOutcome_Discovered() when discovered != null:
return discovered(_that);case ProjectsOutcome_Started() when started != null:
return started(_that);case ProjectsOutcome_Acknowledged() when acknowledged != null:
return acknowledged(_that);case ProjectsOutcome_Done() when done != null:
return done(_that);case ProjectsOutcome_Failed() when failed != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( ProjectsOutcome_Refused value)  refused,required TResult Function( ProjectsOutcome_Discovered value)  discovered,required TResult Function( ProjectsOutcome_Started value)  started,required TResult Function( ProjectsOutcome_Acknowledged value)  acknowledged,required TResult Function( ProjectsOutcome_Done value)  done,required TResult Function( ProjectsOutcome_Failed value)  failed,}){
final _that = this;
switch (_that) {
case ProjectsOutcome_Refused():
return refused(_that);case ProjectsOutcome_Discovered():
return discovered(_that);case ProjectsOutcome_Started():
return started(_that);case ProjectsOutcome_Acknowledged():
return acknowledged(_that);case ProjectsOutcome_Done():
return done(_that);case ProjectsOutcome_Failed():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( ProjectsOutcome_Refused value)?  refused,TResult? Function( ProjectsOutcome_Discovered value)?  discovered,TResult? Function( ProjectsOutcome_Started value)?  started,TResult? Function( ProjectsOutcome_Acknowledged value)?  acknowledged,TResult? Function( ProjectsOutcome_Done value)?  done,TResult? Function( ProjectsOutcome_Failed value)?  failed,}){
final _that = this;
switch (_that) {
case ProjectsOutcome_Refused() when refused != null:
return refused(_that);case ProjectsOutcome_Discovered() when discovered != null:
return discovered(_that);case ProjectsOutcome_Started() when started != null:
return started(_that);case ProjectsOutcome_Acknowledged() when acknowledged != null:
return acknowledged(_that);case ProjectsOutcome_Done() when done != null:
return done(_that);case ProjectsOutcome_Failed() when failed != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( String message)?  refused,TResult Function( int discovery)?  discovered,TResult Function()?  started,TResult Function( bool accepted)?  acknowledged,TResult Function()?  done,TResult Function()?  failed,required TResult orElse(),}) {final _that = this;
switch (_that) {
case ProjectsOutcome_Refused() when refused != null:
return refused(_that.message);case ProjectsOutcome_Discovered() when discovered != null:
return discovered(_that.discovery);case ProjectsOutcome_Started() when started != null:
return started();case ProjectsOutcome_Acknowledged() when acknowledged != null:
return acknowledged(_that.accepted);case ProjectsOutcome_Done() when done != null:
return done();case ProjectsOutcome_Failed() when failed != null:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( String message)  refused,required TResult Function( int discovery)  discovered,required TResult Function()  started,required TResult Function( bool accepted)  acknowledged,required TResult Function()  done,required TResult Function()  failed,}) {final _that = this;
switch (_that) {
case ProjectsOutcome_Refused():
return refused(_that.message);case ProjectsOutcome_Discovered():
return discovered(_that.discovery);case ProjectsOutcome_Started():
return started();case ProjectsOutcome_Acknowledged():
return acknowledged(_that.accepted);case ProjectsOutcome_Done():
return done();case ProjectsOutcome_Failed():
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( String message)?  refused,TResult? Function( int discovery)?  discovered,TResult? Function()?  started,TResult? Function( bool accepted)?  acknowledged,TResult? Function()?  done,TResult? Function()?  failed,}) {final _that = this;
switch (_that) {
case ProjectsOutcome_Refused() when refused != null:
return refused(_that.message);case ProjectsOutcome_Discovered() when discovered != null:
return discovered(_that.discovery);case ProjectsOutcome_Started() when started != null:
return started();case ProjectsOutcome_Acknowledged() when acknowledged != null:
return acknowledged(_that.accepted);case ProjectsOutcome_Done() when done != null:
return done();case ProjectsOutcome_Failed() when failed != null:
return failed();case _:
  return null;

}
}

}

/// @nodoc


class ProjectsOutcome_Refused extends ProjectsOutcome {
  const ProjectsOutcome_Refused({required this.message}): super._();
  

 final  String message;

/// Create a copy of ProjectsOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ProjectsOutcome_RefusedCopyWith<ProjectsOutcome_Refused> get copyWith => _$ProjectsOutcome_RefusedCopyWithImpl<ProjectsOutcome_Refused>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ProjectsOutcome_Refused&&(identical(other.message, message) || other.message == message));
}


@override
int get hashCode => Object.hash(runtimeType,message);

@override
String toString() {
  return 'ProjectsOutcome.refused(message: $message)';
}


}

/// @nodoc
abstract mixin class $ProjectsOutcome_RefusedCopyWith<$Res> implements $ProjectsOutcomeCopyWith<$Res> {
  factory $ProjectsOutcome_RefusedCopyWith(ProjectsOutcome_Refused value, $Res Function(ProjectsOutcome_Refused) _then) = _$ProjectsOutcome_RefusedCopyWithImpl;
@useResult
$Res call({
 String message
});




}
/// @nodoc
class _$ProjectsOutcome_RefusedCopyWithImpl<$Res>
    implements $ProjectsOutcome_RefusedCopyWith<$Res> {
  _$ProjectsOutcome_RefusedCopyWithImpl(this._self, this._then);

  final ProjectsOutcome_Refused _self;
  final $Res Function(ProjectsOutcome_Refused) _then;

/// Create a copy of ProjectsOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? message = null,}) {
  return _then(ProjectsOutcome_Refused(
message: null == message ? _self.message : message // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class ProjectsOutcome_Discovered extends ProjectsOutcome {
  const ProjectsOutcome_Discovered({required this.discovery}): super._();
  

 final  int discovery;

/// Create a copy of ProjectsOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ProjectsOutcome_DiscoveredCopyWith<ProjectsOutcome_Discovered> get copyWith => _$ProjectsOutcome_DiscoveredCopyWithImpl<ProjectsOutcome_Discovered>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ProjectsOutcome_Discovered&&(identical(other.discovery, discovery) || other.discovery == discovery));
}


@override
int get hashCode => Object.hash(runtimeType,discovery);

@override
String toString() {
  return 'ProjectsOutcome.discovered(discovery: $discovery)';
}


}

/// @nodoc
abstract mixin class $ProjectsOutcome_DiscoveredCopyWith<$Res> implements $ProjectsOutcomeCopyWith<$Res> {
  factory $ProjectsOutcome_DiscoveredCopyWith(ProjectsOutcome_Discovered value, $Res Function(ProjectsOutcome_Discovered) _then) = _$ProjectsOutcome_DiscoveredCopyWithImpl;
@useResult
$Res call({
 int discovery
});




}
/// @nodoc
class _$ProjectsOutcome_DiscoveredCopyWithImpl<$Res>
    implements $ProjectsOutcome_DiscoveredCopyWith<$Res> {
  _$ProjectsOutcome_DiscoveredCopyWithImpl(this._self, this._then);

  final ProjectsOutcome_Discovered _self;
  final $Res Function(ProjectsOutcome_Discovered) _then;

/// Create a copy of ProjectsOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? discovery = null,}) {
  return _then(ProjectsOutcome_Discovered(
discovery: null == discovery ? _self.discovery : discovery // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}

/// @nodoc


class ProjectsOutcome_Started extends ProjectsOutcome {
  const ProjectsOutcome_Started(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ProjectsOutcome_Started);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'ProjectsOutcome.started()';
}


}




/// @nodoc


class ProjectsOutcome_Acknowledged extends ProjectsOutcome {
  const ProjectsOutcome_Acknowledged({required this.accepted}): super._();
  

 final  bool accepted;

/// Create a copy of ProjectsOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ProjectsOutcome_AcknowledgedCopyWith<ProjectsOutcome_Acknowledged> get copyWith => _$ProjectsOutcome_AcknowledgedCopyWithImpl<ProjectsOutcome_Acknowledged>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ProjectsOutcome_Acknowledged&&(identical(other.accepted, accepted) || other.accepted == accepted));
}


@override
int get hashCode => Object.hash(runtimeType,accepted);

@override
String toString() {
  return 'ProjectsOutcome.acknowledged(accepted: $accepted)';
}


}

/// @nodoc
abstract mixin class $ProjectsOutcome_AcknowledgedCopyWith<$Res> implements $ProjectsOutcomeCopyWith<$Res> {
  factory $ProjectsOutcome_AcknowledgedCopyWith(ProjectsOutcome_Acknowledged value, $Res Function(ProjectsOutcome_Acknowledged) _then) = _$ProjectsOutcome_AcknowledgedCopyWithImpl;
@useResult
$Res call({
 bool accepted
});




}
/// @nodoc
class _$ProjectsOutcome_AcknowledgedCopyWithImpl<$Res>
    implements $ProjectsOutcome_AcknowledgedCopyWith<$Res> {
  _$ProjectsOutcome_AcknowledgedCopyWithImpl(this._self, this._then);

  final ProjectsOutcome_Acknowledged _self;
  final $Res Function(ProjectsOutcome_Acknowledged) _then;

/// Create a copy of ProjectsOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? accepted = null,}) {
  return _then(ProjectsOutcome_Acknowledged(
accepted: null == accepted ? _self.accepted : accepted // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class ProjectsOutcome_Done extends ProjectsOutcome {
  const ProjectsOutcome_Done(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ProjectsOutcome_Done);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'ProjectsOutcome.done()';
}


}




/// @nodoc


class ProjectsOutcome_Failed extends ProjectsOutcome {
  const ProjectsOutcome_Failed(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ProjectsOutcome_Failed);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'ProjectsOutcome.failed()';
}


}




// dart format on
