// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'pipelines.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;
/// @nodoc
mixin _$PipelineContentSource {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelineContentSource);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'PipelineContentSource()';
}


}

/// @nodoc
class $PipelineContentSourceCopyWith<$Res>  {
$PipelineContentSourceCopyWith(PipelineContentSource _, $Res Function(PipelineContentSource) __);
}


/// Adds pattern-matching-related methods to [PipelineContentSource].
extension PipelineContentSourcePatterns on PipelineContentSource {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( PipelineContentSource_StepOutput value)?  stepOutput,TResult Function( PipelineContentSource_Report value)?  report,required TResult orElse(),}){
final _that = this;
switch (_that) {
case PipelineContentSource_StepOutput() when stepOutput != null:
return stepOutput(_that);case PipelineContentSource_Report() when report != null:
return report(_that);case _:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( PipelineContentSource_StepOutput value)  stepOutput,required TResult Function( PipelineContentSource_Report value)  report,}){
final _that = this;
switch (_that) {
case PipelineContentSource_StepOutput():
return stepOutput(_that);case PipelineContentSource_Report():
return report(_that);}
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( PipelineContentSource_StepOutput value)?  stepOutput,TResult? Function( PipelineContentSource_Report value)?  report,}){
final _that = this;
switch (_that) {
case PipelineContentSource_StepOutput() when stepOutput != null:
return stepOutput(_that);case PipelineContentSource_Report() when report != null:
return report(_that);case _:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( String jobId,  String stepId)?  stepOutput,TResult Function()?  report,required TResult orElse(),}) {final _that = this;
switch (_that) {
case PipelineContentSource_StepOutput() when stepOutput != null:
return stepOutput(_that.jobId,_that.stepId);case PipelineContentSource_Report() when report != null:
return report();case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( String jobId,  String stepId)  stepOutput,required TResult Function()  report,}) {final _that = this;
switch (_that) {
case PipelineContentSource_StepOutput():
return stepOutput(_that.jobId,_that.stepId);case PipelineContentSource_Report():
return report();}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( String jobId,  String stepId)?  stepOutput,TResult? Function()?  report,}) {final _that = this;
switch (_that) {
case PipelineContentSource_StepOutput() when stepOutput != null:
return stepOutput(_that.jobId,_that.stepId);case PipelineContentSource_Report() when report != null:
return report();case _:
  return null;

}
}

}

/// @nodoc


class PipelineContentSource_StepOutput extends PipelineContentSource {
  const PipelineContentSource_StepOutput({required this.jobId, required this.stepId}): super._();
  

 final  String jobId;
 final  String stepId;

/// Create a copy of PipelineContentSource
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PipelineContentSource_StepOutputCopyWith<PipelineContentSource_StepOutput> get copyWith => _$PipelineContentSource_StepOutputCopyWithImpl<PipelineContentSource_StepOutput>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelineContentSource_StepOutput&&(identical(other.jobId, jobId) || other.jobId == jobId)&&(identical(other.stepId, stepId) || other.stepId == stepId));
}


@override
int get hashCode => Object.hash(runtimeType,jobId,stepId);

@override
String toString() {
  return 'PipelineContentSource.stepOutput(jobId: $jobId, stepId: $stepId)';
}


}

/// @nodoc
abstract mixin class $PipelineContentSource_StepOutputCopyWith<$Res> implements $PipelineContentSourceCopyWith<$Res> {
  factory $PipelineContentSource_StepOutputCopyWith(PipelineContentSource_StepOutput value, $Res Function(PipelineContentSource_StepOutput) _then) = _$PipelineContentSource_StepOutputCopyWithImpl;
@useResult
$Res call({
 String jobId, String stepId
});




}
/// @nodoc
class _$PipelineContentSource_StepOutputCopyWithImpl<$Res>
    implements $PipelineContentSource_StepOutputCopyWith<$Res> {
  _$PipelineContentSource_StepOutputCopyWithImpl(this._self, this._then);

  final PipelineContentSource_StepOutput _self;
  final $Res Function(PipelineContentSource_StepOutput) _then;

/// Create a copy of PipelineContentSource
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? jobId = null,Object? stepId = null,}) {
  return _then(PipelineContentSource_StepOutput(
jobId: null == jobId ? _self.jobId : jobId // ignore: cast_nullable_to_non_nullable
as String,stepId: null == stepId ? _self.stepId : stepId // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class PipelineContentSource_Report extends PipelineContentSource {
  const PipelineContentSource_Report(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelineContentSource_Report);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'PipelineContentSource.report()';
}


}




/// @nodoc
mixin _$PipelinesIntent {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesIntent);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'PipelinesIntent()';
}


}

/// @nodoc
class $PipelinesIntentCopyWith<$Res>  {
$PipelinesIntentCopyWith(PipelinesIntent _, $Res Function(PipelinesIntent) __);
}


/// Adds pattern-matching-related methods to [PipelinesIntent].
extension PipelinesIntentPatterns on PipelinesIntent {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( PipelinesIntent_SetConnected value)?  setConnected,TResult Function( PipelinesIntent_Watch value)?  watch,TResult Function( PipelinesIntent_Release value)?  release,TResult Function( PipelinesIntent_Load value)?  load,TResult Function( PipelinesIntent_Get value)?  get_,TResult Function( PipelinesIntent_Log value)?  log,TResult Function( PipelinesIntent_ClearLogSelection value)?  clearLogSelection,TResult Function( PipelinesIntent_Control value)?  control,TResult Function( PipelinesIntent_ClearActionError value)?  clearActionError,TResult Function( PipelinesIntent_Form value)?  form,TResult Function( PipelinesIntent_Start value)?  start,TResult Function( PipelinesIntent_Content value)?  content,TResult Function( PipelinesIntent_Follow value)?  follow,TResult Function( PipelinesIntent_Unfollow value)?  unfollow,TResult Function( PipelinesIntent_DrawerUpdate value)?  drawerUpdate,TResult Function( PipelinesIntent_DrawerRetry value)?  drawerRetry,TResult Function( PipelinesIntent_DrawerAct value)?  drawerAct,TResult Function( PipelinesIntent_DrawerClose value)?  drawerClose,TResult Function( PipelinesIntent_Close value)?  close,required TResult orElse(),}){
final _that = this;
switch (_that) {
case PipelinesIntent_SetConnected() when setConnected != null:
return setConnected(_that);case PipelinesIntent_Watch() when watch != null:
return watch(_that);case PipelinesIntent_Release() when release != null:
return release(_that);case PipelinesIntent_Load() when load != null:
return load(_that);case PipelinesIntent_Get() when get_ != null:
return get_(_that);case PipelinesIntent_Log() when log != null:
return log(_that);case PipelinesIntent_ClearLogSelection() when clearLogSelection != null:
return clearLogSelection(_that);case PipelinesIntent_Control() when control != null:
return control(_that);case PipelinesIntent_ClearActionError() when clearActionError != null:
return clearActionError(_that);case PipelinesIntent_Form() when form != null:
return form(_that);case PipelinesIntent_Start() when start != null:
return start(_that);case PipelinesIntent_Content() when content != null:
return content(_that);case PipelinesIntent_Follow() when follow != null:
return follow(_that);case PipelinesIntent_Unfollow() when unfollow != null:
return unfollow(_that);case PipelinesIntent_DrawerUpdate() when drawerUpdate != null:
return drawerUpdate(_that);case PipelinesIntent_DrawerRetry() when drawerRetry != null:
return drawerRetry(_that);case PipelinesIntent_DrawerAct() when drawerAct != null:
return drawerAct(_that);case PipelinesIntent_DrawerClose() when drawerClose != null:
return drawerClose(_that);case PipelinesIntent_Close() when close != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( PipelinesIntent_SetConnected value)  setConnected,required TResult Function( PipelinesIntent_Watch value)  watch,required TResult Function( PipelinesIntent_Release value)  release,required TResult Function( PipelinesIntent_Load value)  load,required TResult Function( PipelinesIntent_Get value)  get_,required TResult Function( PipelinesIntent_Log value)  log,required TResult Function( PipelinesIntent_ClearLogSelection value)  clearLogSelection,required TResult Function( PipelinesIntent_Control value)  control,required TResult Function( PipelinesIntent_ClearActionError value)  clearActionError,required TResult Function( PipelinesIntent_Form value)  form,required TResult Function( PipelinesIntent_Start value)  start,required TResult Function( PipelinesIntent_Content value)  content,required TResult Function( PipelinesIntent_Follow value)  follow,required TResult Function( PipelinesIntent_Unfollow value)  unfollow,required TResult Function( PipelinesIntent_DrawerUpdate value)  drawerUpdate,required TResult Function( PipelinesIntent_DrawerRetry value)  drawerRetry,required TResult Function( PipelinesIntent_DrawerAct value)  drawerAct,required TResult Function( PipelinesIntent_DrawerClose value)  drawerClose,required TResult Function( PipelinesIntent_Close value)  close,}){
final _that = this;
switch (_that) {
case PipelinesIntent_SetConnected():
return setConnected(_that);case PipelinesIntent_Watch():
return watch(_that);case PipelinesIntent_Release():
return release(_that);case PipelinesIntent_Load():
return load(_that);case PipelinesIntent_Get():
return get_(_that);case PipelinesIntent_Log():
return log(_that);case PipelinesIntent_ClearLogSelection():
return clearLogSelection(_that);case PipelinesIntent_Control():
return control(_that);case PipelinesIntent_ClearActionError():
return clearActionError(_that);case PipelinesIntent_Form():
return form(_that);case PipelinesIntent_Start():
return start(_that);case PipelinesIntent_Content():
return content(_that);case PipelinesIntent_Follow():
return follow(_that);case PipelinesIntent_Unfollow():
return unfollow(_that);case PipelinesIntent_DrawerUpdate():
return drawerUpdate(_that);case PipelinesIntent_DrawerRetry():
return drawerRetry(_that);case PipelinesIntent_DrawerAct():
return drawerAct(_that);case PipelinesIntent_DrawerClose():
return drawerClose(_that);case PipelinesIntent_Close():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( PipelinesIntent_SetConnected value)?  setConnected,TResult? Function( PipelinesIntent_Watch value)?  watch,TResult? Function( PipelinesIntent_Release value)?  release,TResult? Function( PipelinesIntent_Load value)?  load,TResult? Function( PipelinesIntent_Get value)?  get_,TResult? Function( PipelinesIntent_Log value)?  log,TResult? Function( PipelinesIntent_ClearLogSelection value)?  clearLogSelection,TResult? Function( PipelinesIntent_Control value)?  control,TResult? Function( PipelinesIntent_ClearActionError value)?  clearActionError,TResult? Function( PipelinesIntent_Form value)?  form,TResult? Function( PipelinesIntent_Start value)?  start,TResult? Function( PipelinesIntent_Content value)?  content,TResult? Function( PipelinesIntent_Follow value)?  follow,TResult? Function( PipelinesIntent_Unfollow value)?  unfollow,TResult? Function( PipelinesIntent_DrawerUpdate value)?  drawerUpdate,TResult? Function( PipelinesIntent_DrawerRetry value)?  drawerRetry,TResult? Function( PipelinesIntent_DrawerAct value)?  drawerAct,TResult? Function( PipelinesIntent_DrawerClose value)?  drawerClose,TResult? Function( PipelinesIntent_Close value)?  close,}){
final _that = this;
switch (_that) {
case PipelinesIntent_SetConnected() when setConnected != null:
return setConnected(_that);case PipelinesIntent_Watch() when watch != null:
return watch(_that);case PipelinesIntent_Release() when release != null:
return release(_that);case PipelinesIntent_Load() when load != null:
return load(_that);case PipelinesIntent_Get() when get_ != null:
return get_(_that);case PipelinesIntent_Log() when log != null:
return log(_that);case PipelinesIntent_ClearLogSelection() when clearLogSelection != null:
return clearLogSelection(_that);case PipelinesIntent_Control() when control != null:
return control(_that);case PipelinesIntent_ClearActionError() when clearActionError != null:
return clearActionError(_that);case PipelinesIntent_Form() when form != null:
return form(_that);case PipelinesIntent_Start() when start != null:
return start(_that);case PipelinesIntent_Content() when content != null:
return content(_that);case PipelinesIntent_Follow() when follow != null:
return follow(_that);case PipelinesIntent_Unfollow() when unfollow != null:
return unfollow(_that);case PipelinesIntent_DrawerUpdate() when drawerUpdate != null:
return drawerUpdate(_that);case PipelinesIntent_DrawerRetry() when drawerRetry != null:
return drawerRetry(_that);case PipelinesIntent_DrawerAct() when drawerAct != null:
return drawerAct(_that);case PipelinesIntent_DrawerClose() when drawerClose != null:
return drawerClose(_that);case PipelinesIntent_Close() when close != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( bool connected)?  setConnected,TResult Function( ChatRefView chat,  int token)?  watch,TResult Function( int token)?  release,TResult Function( ChatRefView chat)?  load,TResult Function( ChatRefView chat,  String id)?  get_,TResult Function( ChatRefView chat,  String id,  String jobId,  String stepId)?  log,TResult Function( ChatRefView chat,  String id)?  clearLogSelection,TResult Function( ChatRefView chat,  String id,  PipelineAction action)?  control,TResult Function( ChatRefView chat,  String id)?  clearActionError,TResult Function( ChatRefView chat,  String pipelineId,  PipelineOrigin origin)?  form,TResult Function( ChatRefView chat,  String pipelineId,  PipelineOrigin origin,  List<PipelineInputValue> inputs)?  start,TResult Function( ChatRefView chat,  String id,  PipelineContentSource source)?  content,TResult Function( int token,  ChatRefView? chat,  bool online)?  follow,TResult Function( int token)?  unfollow,TResult Function( int token,  ChatRefView chat,  bool online,  bool ready)?  drawerUpdate,TResult Function( int token)?  drawerRetry,TResult Function( int token,  String itemId,  WorkAction action,  bool notifySubscriber)?  drawerAct,TResult Function( int token)?  drawerClose,TResult Function()?  close,required TResult orElse(),}) {final _that = this;
switch (_that) {
case PipelinesIntent_SetConnected() when setConnected != null:
return setConnected(_that.connected);case PipelinesIntent_Watch() when watch != null:
return watch(_that.chat,_that.token);case PipelinesIntent_Release() when release != null:
return release(_that.token);case PipelinesIntent_Load() when load != null:
return load(_that.chat);case PipelinesIntent_Get() when get_ != null:
return get_(_that.chat,_that.id);case PipelinesIntent_Log() when log != null:
return log(_that.chat,_that.id,_that.jobId,_that.stepId);case PipelinesIntent_ClearLogSelection() when clearLogSelection != null:
return clearLogSelection(_that.chat,_that.id);case PipelinesIntent_Control() when control != null:
return control(_that.chat,_that.id,_that.action);case PipelinesIntent_ClearActionError() when clearActionError != null:
return clearActionError(_that.chat,_that.id);case PipelinesIntent_Form() when form != null:
return form(_that.chat,_that.pipelineId,_that.origin);case PipelinesIntent_Start() when start != null:
return start(_that.chat,_that.pipelineId,_that.origin,_that.inputs);case PipelinesIntent_Content() when content != null:
return content(_that.chat,_that.id,_that.source);case PipelinesIntent_Follow() when follow != null:
return follow(_that.token,_that.chat,_that.online);case PipelinesIntent_Unfollow() when unfollow != null:
return unfollow(_that.token);case PipelinesIntent_DrawerUpdate() when drawerUpdate != null:
return drawerUpdate(_that.token,_that.chat,_that.online,_that.ready);case PipelinesIntent_DrawerRetry() when drawerRetry != null:
return drawerRetry(_that.token);case PipelinesIntent_DrawerAct() when drawerAct != null:
return drawerAct(_that.token,_that.itemId,_that.action,_that.notifySubscriber);case PipelinesIntent_DrawerClose() when drawerClose != null:
return drawerClose(_that.token);case PipelinesIntent_Close() when close != null:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( bool connected)  setConnected,required TResult Function( ChatRefView chat,  int token)  watch,required TResult Function( int token)  release,required TResult Function( ChatRefView chat)  load,required TResult Function( ChatRefView chat,  String id)  get_,required TResult Function( ChatRefView chat,  String id,  String jobId,  String stepId)  log,required TResult Function( ChatRefView chat,  String id)  clearLogSelection,required TResult Function( ChatRefView chat,  String id,  PipelineAction action)  control,required TResult Function( ChatRefView chat,  String id)  clearActionError,required TResult Function( ChatRefView chat,  String pipelineId,  PipelineOrigin origin)  form,required TResult Function( ChatRefView chat,  String pipelineId,  PipelineOrigin origin,  List<PipelineInputValue> inputs)  start,required TResult Function( ChatRefView chat,  String id,  PipelineContentSource source)  content,required TResult Function( int token,  ChatRefView? chat,  bool online)  follow,required TResult Function( int token)  unfollow,required TResult Function( int token,  ChatRefView chat,  bool online,  bool ready)  drawerUpdate,required TResult Function( int token)  drawerRetry,required TResult Function( int token,  String itemId,  WorkAction action,  bool notifySubscriber)  drawerAct,required TResult Function( int token)  drawerClose,required TResult Function()  close,}) {final _that = this;
switch (_that) {
case PipelinesIntent_SetConnected():
return setConnected(_that.connected);case PipelinesIntent_Watch():
return watch(_that.chat,_that.token);case PipelinesIntent_Release():
return release(_that.token);case PipelinesIntent_Load():
return load(_that.chat);case PipelinesIntent_Get():
return get_(_that.chat,_that.id);case PipelinesIntent_Log():
return log(_that.chat,_that.id,_that.jobId,_that.stepId);case PipelinesIntent_ClearLogSelection():
return clearLogSelection(_that.chat,_that.id);case PipelinesIntent_Control():
return control(_that.chat,_that.id,_that.action);case PipelinesIntent_ClearActionError():
return clearActionError(_that.chat,_that.id);case PipelinesIntent_Form():
return form(_that.chat,_that.pipelineId,_that.origin);case PipelinesIntent_Start():
return start(_that.chat,_that.pipelineId,_that.origin,_that.inputs);case PipelinesIntent_Content():
return content(_that.chat,_that.id,_that.source);case PipelinesIntent_Follow():
return follow(_that.token,_that.chat,_that.online);case PipelinesIntent_Unfollow():
return unfollow(_that.token);case PipelinesIntent_DrawerUpdate():
return drawerUpdate(_that.token,_that.chat,_that.online,_that.ready);case PipelinesIntent_DrawerRetry():
return drawerRetry(_that.token);case PipelinesIntent_DrawerAct():
return drawerAct(_that.token,_that.itemId,_that.action,_that.notifySubscriber);case PipelinesIntent_DrawerClose():
return drawerClose(_that.token);case PipelinesIntent_Close():
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( bool connected)?  setConnected,TResult? Function( ChatRefView chat,  int token)?  watch,TResult? Function( int token)?  release,TResult? Function( ChatRefView chat)?  load,TResult? Function( ChatRefView chat,  String id)?  get_,TResult? Function( ChatRefView chat,  String id,  String jobId,  String stepId)?  log,TResult? Function( ChatRefView chat,  String id)?  clearLogSelection,TResult? Function( ChatRefView chat,  String id,  PipelineAction action)?  control,TResult? Function( ChatRefView chat,  String id)?  clearActionError,TResult? Function( ChatRefView chat,  String pipelineId,  PipelineOrigin origin)?  form,TResult? Function( ChatRefView chat,  String pipelineId,  PipelineOrigin origin,  List<PipelineInputValue> inputs)?  start,TResult? Function( ChatRefView chat,  String id,  PipelineContentSource source)?  content,TResult? Function( int token,  ChatRefView? chat,  bool online)?  follow,TResult? Function( int token)?  unfollow,TResult? Function( int token,  ChatRefView chat,  bool online,  bool ready)?  drawerUpdate,TResult? Function( int token)?  drawerRetry,TResult? Function( int token,  String itemId,  WorkAction action,  bool notifySubscriber)?  drawerAct,TResult? Function( int token)?  drawerClose,TResult? Function()?  close,}) {final _that = this;
switch (_that) {
case PipelinesIntent_SetConnected() when setConnected != null:
return setConnected(_that.connected);case PipelinesIntent_Watch() when watch != null:
return watch(_that.chat,_that.token);case PipelinesIntent_Release() when release != null:
return release(_that.token);case PipelinesIntent_Load() when load != null:
return load(_that.chat);case PipelinesIntent_Get() when get_ != null:
return get_(_that.chat,_that.id);case PipelinesIntent_Log() when log != null:
return log(_that.chat,_that.id,_that.jobId,_that.stepId);case PipelinesIntent_ClearLogSelection() when clearLogSelection != null:
return clearLogSelection(_that.chat,_that.id);case PipelinesIntent_Control() when control != null:
return control(_that.chat,_that.id,_that.action);case PipelinesIntent_ClearActionError() when clearActionError != null:
return clearActionError(_that.chat,_that.id);case PipelinesIntent_Form() when form != null:
return form(_that.chat,_that.pipelineId,_that.origin);case PipelinesIntent_Start() when start != null:
return start(_that.chat,_that.pipelineId,_that.origin,_that.inputs);case PipelinesIntent_Content() when content != null:
return content(_that.chat,_that.id,_that.source);case PipelinesIntent_Follow() when follow != null:
return follow(_that.token,_that.chat,_that.online);case PipelinesIntent_Unfollow() when unfollow != null:
return unfollow(_that.token);case PipelinesIntent_DrawerUpdate() when drawerUpdate != null:
return drawerUpdate(_that.token,_that.chat,_that.online,_that.ready);case PipelinesIntent_DrawerRetry() when drawerRetry != null:
return drawerRetry(_that.token);case PipelinesIntent_DrawerAct() when drawerAct != null:
return drawerAct(_that.token,_that.itemId,_that.action,_that.notifySubscriber);case PipelinesIntent_DrawerClose() when drawerClose != null:
return drawerClose(_that.token);case PipelinesIntent_Close() when close != null:
return close();case _:
  return null;

}
}

}

/// @nodoc


class PipelinesIntent_SetConnected extends PipelinesIntent {
  const PipelinesIntent_SetConnected({required this.connected}): super._();
  

 final  bool connected;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PipelinesIntent_SetConnectedCopyWith<PipelinesIntent_SetConnected> get copyWith => _$PipelinesIntent_SetConnectedCopyWithImpl<PipelinesIntent_SetConnected>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesIntent_SetConnected&&(identical(other.connected, connected) || other.connected == connected));
}


@override
int get hashCode => Object.hash(runtimeType,connected);

@override
String toString() {
  return 'PipelinesIntent.setConnected(connected: $connected)';
}


}

/// @nodoc
abstract mixin class $PipelinesIntent_SetConnectedCopyWith<$Res> implements $PipelinesIntentCopyWith<$Res> {
  factory $PipelinesIntent_SetConnectedCopyWith(PipelinesIntent_SetConnected value, $Res Function(PipelinesIntent_SetConnected) _then) = _$PipelinesIntent_SetConnectedCopyWithImpl;
@useResult
$Res call({
 bool connected
});




}
/// @nodoc
class _$PipelinesIntent_SetConnectedCopyWithImpl<$Res>
    implements $PipelinesIntent_SetConnectedCopyWith<$Res> {
  _$PipelinesIntent_SetConnectedCopyWithImpl(this._self, this._then);

  final PipelinesIntent_SetConnected _self;
  final $Res Function(PipelinesIntent_SetConnected) _then;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? connected = null,}) {
  return _then(PipelinesIntent_SetConnected(
connected: null == connected ? _self.connected : connected // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class PipelinesIntent_Watch extends PipelinesIntent {
  const PipelinesIntent_Watch({required this.chat, required this.token}): super._();
  

 final  ChatRefView chat;
 final  int token;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PipelinesIntent_WatchCopyWith<PipelinesIntent_Watch> get copyWith => _$PipelinesIntent_WatchCopyWithImpl<PipelinesIntent_Watch>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesIntent_Watch&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.token, token) || other.token == token));
}


@override
int get hashCode => Object.hash(runtimeType,chat,token);

@override
String toString() {
  return 'PipelinesIntent.watch(chat: $chat, token: $token)';
}


}

/// @nodoc
abstract mixin class $PipelinesIntent_WatchCopyWith<$Res> implements $PipelinesIntentCopyWith<$Res> {
  factory $PipelinesIntent_WatchCopyWith(PipelinesIntent_Watch value, $Res Function(PipelinesIntent_Watch) _then) = _$PipelinesIntent_WatchCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, int token
});




}
/// @nodoc
class _$PipelinesIntent_WatchCopyWithImpl<$Res>
    implements $PipelinesIntent_WatchCopyWith<$Res> {
  _$PipelinesIntent_WatchCopyWithImpl(this._self, this._then);

  final PipelinesIntent_Watch _self;
  final $Res Function(PipelinesIntent_Watch) _then;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? token = null,}) {
  return _then(PipelinesIntent_Watch(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,token: null == token ? _self.token : token // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}

/// @nodoc


class PipelinesIntent_Release extends PipelinesIntent {
  const PipelinesIntent_Release({required this.token}): super._();
  

 final  int token;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PipelinesIntent_ReleaseCopyWith<PipelinesIntent_Release> get copyWith => _$PipelinesIntent_ReleaseCopyWithImpl<PipelinesIntent_Release>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesIntent_Release&&(identical(other.token, token) || other.token == token));
}


@override
int get hashCode => Object.hash(runtimeType,token);

@override
String toString() {
  return 'PipelinesIntent.release(token: $token)';
}


}

/// @nodoc
abstract mixin class $PipelinesIntent_ReleaseCopyWith<$Res> implements $PipelinesIntentCopyWith<$Res> {
  factory $PipelinesIntent_ReleaseCopyWith(PipelinesIntent_Release value, $Res Function(PipelinesIntent_Release) _then) = _$PipelinesIntent_ReleaseCopyWithImpl;
@useResult
$Res call({
 int token
});




}
/// @nodoc
class _$PipelinesIntent_ReleaseCopyWithImpl<$Res>
    implements $PipelinesIntent_ReleaseCopyWith<$Res> {
  _$PipelinesIntent_ReleaseCopyWithImpl(this._self, this._then);

  final PipelinesIntent_Release _self;
  final $Res Function(PipelinesIntent_Release) _then;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? token = null,}) {
  return _then(PipelinesIntent_Release(
token: null == token ? _self.token : token // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}

/// @nodoc


class PipelinesIntent_Load extends PipelinesIntent {
  const PipelinesIntent_Load({required this.chat}): super._();
  

 final  ChatRefView chat;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PipelinesIntent_LoadCopyWith<PipelinesIntent_Load> get copyWith => _$PipelinesIntent_LoadCopyWithImpl<PipelinesIntent_Load>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesIntent_Load&&(identical(other.chat, chat) || other.chat == chat));
}


@override
int get hashCode => Object.hash(runtimeType,chat);

@override
String toString() {
  return 'PipelinesIntent.load(chat: $chat)';
}


}

/// @nodoc
abstract mixin class $PipelinesIntent_LoadCopyWith<$Res> implements $PipelinesIntentCopyWith<$Res> {
  factory $PipelinesIntent_LoadCopyWith(PipelinesIntent_Load value, $Res Function(PipelinesIntent_Load) _then) = _$PipelinesIntent_LoadCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat
});




}
/// @nodoc
class _$PipelinesIntent_LoadCopyWithImpl<$Res>
    implements $PipelinesIntent_LoadCopyWith<$Res> {
  _$PipelinesIntent_LoadCopyWithImpl(this._self, this._then);

  final PipelinesIntent_Load _self;
  final $Res Function(PipelinesIntent_Load) _then;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,}) {
  return _then(PipelinesIntent_Load(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,
  ));
}


}

/// @nodoc


class PipelinesIntent_Get extends PipelinesIntent {
  const PipelinesIntent_Get({required this.chat, required this.id}): super._();
  

 final  ChatRefView chat;
 final  String id;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PipelinesIntent_GetCopyWith<PipelinesIntent_Get> get copyWith => _$PipelinesIntent_GetCopyWithImpl<PipelinesIntent_Get>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesIntent_Get&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.id, id) || other.id == id));
}


@override
int get hashCode => Object.hash(runtimeType,chat,id);

@override
String toString() {
  return 'PipelinesIntent.get_(chat: $chat, id: $id)';
}


}

/// @nodoc
abstract mixin class $PipelinesIntent_GetCopyWith<$Res> implements $PipelinesIntentCopyWith<$Res> {
  factory $PipelinesIntent_GetCopyWith(PipelinesIntent_Get value, $Res Function(PipelinesIntent_Get) _then) = _$PipelinesIntent_GetCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, String id
});




}
/// @nodoc
class _$PipelinesIntent_GetCopyWithImpl<$Res>
    implements $PipelinesIntent_GetCopyWith<$Res> {
  _$PipelinesIntent_GetCopyWithImpl(this._self, this._then);

  final PipelinesIntent_Get _self;
  final $Res Function(PipelinesIntent_Get) _then;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? id = null,}) {
  return _then(PipelinesIntent_Get(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class PipelinesIntent_Log extends PipelinesIntent {
  const PipelinesIntent_Log({required this.chat, required this.id, required this.jobId, required this.stepId}): super._();
  

 final  ChatRefView chat;
 final  String id;
 final  String jobId;
 final  String stepId;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PipelinesIntent_LogCopyWith<PipelinesIntent_Log> get copyWith => _$PipelinesIntent_LogCopyWithImpl<PipelinesIntent_Log>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesIntent_Log&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.id, id) || other.id == id)&&(identical(other.jobId, jobId) || other.jobId == jobId)&&(identical(other.stepId, stepId) || other.stepId == stepId));
}


@override
int get hashCode => Object.hash(runtimeType,chat,id,jobId,stepId);

@override
String toString() {
  return 'PipelinesIntent.log(chat: $chat, id: $id, jobId: $jobId, stepId: $stepId)';
}


}

/// @nodoc
abstract mixin class $PipelinesIntent_LogCopyWith<$Res> implements $PipelinesIntentCopyWith<$Res> {
  factory $PipelinesIntent_LogCopyWith(PipelinesIntent_Log value, $Res Function(PipelinesIntent_Log) _then) = _$PipelinesIntent_LogCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, String id, String jobId, String stepId
});




}
/// @nodoc
class _$PipelinesIntent_LogCopyWithImpl<$Res>
    implements $PipelinesIntent_LogCopyWith<$Res> {
  _$PipelinesIntent_LogCopyWithImpl(this._self, this._then);

  final PipelinesIntent_Log _self;
  final $Res Function(PipelinesIntent_Log) _then;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? id = null,Object? jobId = null,Object? stepId = null,}) {
  return _then(PipelinesIntent_Log(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,jobId: null == jobId ? _self.jobId : jobId // ignore: cast_nullable_to_non_nullable
as String,stepId: null == stepId ? _self.stepId : stepId // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class PipelinesIntent_ClearLogSelection extends PipelinesIntent {
  const PipelinesIntent_ClearLogSelection({required this.chat, required this.id}): super._();
  

 final  ChatRefView chat;
 final  String id;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PipelinesIntent_ClearLogSelectionCopyWith<PipelinesIntent_ClearLogSelection> get copyWith => _$PipelinesIntent_ClearLogSelectionCopyWithImpl<PipelinesIntent_ClearLogSelection>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesIntent_ClearLogSelection&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.id, id) || other.id == id));
}


@override
int get hashCode => Object.hash(runtimeType,chat,id);

@override
String toString() {
  return 'PipelinesIntent.clearLogSelection(chat: $chat, id: $id)';
}


}

/// @nodoc
abstract mixin class $PipelinesIntent_ClearLogSelectionCopyWith<$Res> implements $PipelinesIntentCopyWith<$Res> {
  factory $PipelinesIntent_ClearLogSelectionCopyWith(PipelinesIntent_ClearLogSelection value, $Res Function(PipelinesIntent_ClearLogSelection) _then) = _$PipelinesIntent_ClearLogSelectionCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, String id
});




}
/// @nodoc
class _$PipelinesIntent_ClearLogSelectionCopyWithImpl<$Res>
    implements $PipelinesIntent_ClearLogSelectionCopyWith<$Res> {
  _$PipelinesIntent_ClearLogSelectionCopyWithImpl(this._self, this._then);

  final PipelinesIntent_ClearLogSelection _self;
  final $Res Function(PipelinesIntent_ClearLogSelection) _then;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? id = null,}) {
  return _then(PipelinesIntent_ClearLogSelection(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class PipelinesIntent_Control extends PipelinesIntent {
  const PipelinesIntent_Control({required this.chat, required this.id, required this.action}): super._();
  

 final  ChatRefView chat;
 final  String id;
 final  PipelineAction action;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PipelinesIntent_ControlCopyWith<PipelinesIntent_Control> get copyWith => _$PipelinesIntent_ControlCopyWithImpl<PipelinesIntent_Control>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesIntent_Control&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.id, id) || other.id == id)&&(identical(other.action, action) || other.action == action));
}


@override
int get hashCode => Object.hash(runtimeType,chat,id,action);

@override
String toString() {
  return 'PipelinesIntent.control(chat: $chat, id: $id, action: $action)';
}


}

/// @nodoc
abstract mixin class $PipelinesIntent_ControlCopyWith<$Res> implements $PipelinesIntentCopyWith<$Res> {
  factory $PipelinesIntent_ControlCopyWith(PipelinesIntent_Control value, $Res Function(PipelinesIntent_Control) _then) = _$PipelinesIntent_ControlCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, String id, PipelineAction action
});




}
/// @nodoc
class _$PipelinesIntent_ControlCopyWithImpl<$Res>
    implements $PipelinesIntent_ControlCopyWith<$Res> {
  _$PipelinesIntent_ControlCopyWithImpl(this._self, this._then);

  final PipelinesIntent_Control _self;
  final $Res Function(PipelinesIntent_Control) _then;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? id = null,Object? action = null,}) {
  return _then(PipelinesIntent_Control(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,action: null == action ? _self.action : action // ignore: cast_nullable_to_non_nullable
as PipelineAction,
  ));
}


}

/// @nodoc


class PipelinesIntent_ClearActionError extends PipelinesIntent {
  const PipelinesIntent_ClearActionError({required this.chat, required this.id}): super._();
  

 final  ChatRefView chat;
 final  String id;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PipelinesIntent_ClearActionErrorCopyWith<PipelinesIntent_ClearActionError> get copyWith => _$PipelinesIntent_ClearActionErrorCopyWithImpl<PipelinesIntent_ClearActionError>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesIntent_ClearActionError&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.id, id) || other.id == id));
}


@override
int get hashCode => Object.hash(runtimeType,chat,id);

@override
String toString() {
  return 'PipelinesIntent.clearActionError(chat: $chat, id: $id)';
}


}

/// @nodoc
abstract mixin class $PipelinesIntent_ClearActionErrorCopyWith<$Res> implements $PipelinesIntentCopyWith<$Res> {
  factory $PipelinesIntent_ClearActionErrorCopyWith(PipelinesIntent_ClearActionError value, $Res Function(PipelinesIntent_ClearActionError) _then) = _$PipelinesIntent_ClearActionErrorCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, String id
});




}
/// @nodoc
class _$PipelinesIntent_ClearActionErrorCopyWithImpl<$Res>
    implements $PipelinesIntent_ClearActionErrorCopyWith<$Res> {
  _$PipelinesIntent_ClearActionErrorCopyWithImpl(this._self, this._then);

  final PipelinesIntent_ClearActionError _self;
  final $Res Function(PipelinesIntent_ClearActionError) _then;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? id = null,}) {
  return _then(PipelinesIntent_ClearActionError(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class PipelinesIntent_Form extends PipelinesIntent {
  const PipelinesIntent_Form({required this.chat, required this.pipelineId, required this.origin}): super._();
  

 final  ChatRefView chat;
 final  String pipelineId;
 final  PipelineOrigin origin;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PipelinesIntent_FormCopyWith<PipelinesIntent_Form> get copyWith => _$PipelinesIntent_FormCopyWithImpl<PipelinesIntent_Form>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesIntent_Form&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.pipelineId, pipelineId) || other.pipelineId == pipelineId)&&(identical(other.origin, origin) || other.origin == origin));
}


@override
int get hashCode => Object.hash(runtimeType,chat,pipelineId,origin);

@override
String toString() {
  return 'PipelinesIntent.form(chat: $chat, pipelineId: $pipelineId, origin: $origin)';
}


}

/// @nodoc
abstract mixin class $PipelinesIntent_FormCopyWith<$Res> implements $PipelinesIntentCopyWith<$Res> {
  factory $PipelinesIntent_FormCopyWith(PipelinesIntent_Form value, $Res Function(PipelinesIntent_Form) _then) = _$PipelinesIntent_FormCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, String pipelineId, PipelineOrigin origin
});




}
/// @nodoc
class _$PipelinesIntent_FormCopyWithImpl<$Res>
    implements $PipelinesIntent_FormCopyWith<$Res> {
  _$PipelinesIntent_FormCopyWithImpl(this._self, this._then);

  final PipelinesIntent_Form _self;
  final $Res Function(PipelinesIntent_Form) _then;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? pipelineId = null,Object? origin = null,}) {
  return _then(PipelinesIntent_Form(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,pipelineId: null == pipelineId ? _self.pipelineId : pipelineId // ignore: cast_nullable_to_non_nullable
as String,origin: null == origin ? _self.origin : origin // ignore: cast_nullable_to_non_nullable
as PipelineOrigin,
  ));
}


}

/// @nodoc


class PipelinesIntent_Start extends PipelinesIntent {
  const PipelinesIntent_Start({required this.chat, required this.pipelineId, required this.origin, required final  List<PipelineInputValue> inputs}): _inputs = inputs,super._();
  

 final  ChatRefView chat;
 final  String pipelineId;
 final  PipelineOrigin origin;
 final  List<PipelineInputValue> _inputs;
 List<PipelineInputValue> get inputs {
  if (_inputs is EqualUnmodifiableListView) return _inputs;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_inputs);
}


/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PipelinesIntent_StartCopyWith<PipelinesIntent_Start> get copyWith => _$PipelinesIntent_StartCopyWithImpl<PipelinesIntent_Start>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesIntent_Start&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.pipelineId, pipelineId) || other.pipelineId == pipelineId)&&(identical(other.origin, origin) || other.origin == origin)&&const DeepCollectionEquality().equals(other._inputs, _inputs));
}


@override
int get hashCode => Object.hash(runtimeType,chat,pipelineId,origin,const DeepCollectionEquality().hash(_inputs));

@override
String toString() {
  return 'PipelinesIntent.start(chat: $chat, pipelineId: $pipelineId, origin: $origin, inputs: $inputs)';
}


}

/// @nodoc
abstract mixin class $PipelinesIntent_StartCopyWith<$Res> implements $PipelinesIntentCopyWith<$Res> {
  factory $PipelinesIntent_StartCopyWith(PipelinesIntent_Start value, $Res Function(PipelinesIntent_Start) _then) = _$PipelinesIntent_StartCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, String pipelineId, PipelineOrigin origin, List<PipelineInputValue> inputs
});




}
/// @nodoc
class _$PipelinesIntent_StartCopyWithImpl<$Res>
    implements $PipelinesIntent_StartCopyWith<$Res> {
  _$PipelinesIntent_StartCopyWithImpl(this._self, this._then);

  final PipelinesIntent_Start _self;
  final $Res Function(PipelinesIntent_Start) _then;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? pipelineId = null,Object? origin = null,Object? inputs = null,}) {
  return _then(PipelinesIntent_Start(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,pipelineId: null == pipelineId ? _self.pipelineId : pipelineId // ignore: cast_nullable_to_non_nullable
as String,origin: null == origin ? _self.origin : origin // ignore: cast_nullable_to_non_nullable
as PipelineOrigin,inputs: null == inputs ? _self._inputs : inputs // ignore: cast_nullable_to_non_nullable
as List<PipelineInputValue>,
  ));
}


}

/// @nodoc


class PipelinesIntent_Content extends PipelinesIntent {
  const PipelinesIntent_Content({required this.chat, required this.id, required this.source}): super._();
  

 final  ChatRefView chat;
 final  String id;
 final  PipelineContentSource source;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PipelinesIntent_ContentCopyWith<PipelinesIntent_Content> get copyWith => _$PipelinesIntent_ContentCopyWithImpl<PipelinesIntent_Content>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesIntent_Content&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.id, id) || other.id == id)&&(identical(other.source, source) || other.source == source));
}


@override
int get hashCode => Object.hash(runtimeType,chat,id,source);

@override
String toString() {
  return 'PipelinesIntent.content(chat: $chat, id: $id, source: $source)';
}


}

/// @nodoc
abstract mixin class $PipelinesIntent_ContentCopyWith<$Res> implements $PipelinesIntentCopyWith<$Res> {
  factory $PipelinesIntent_ContentCopyWith(PipelinesIntent_Content value, $Res Function(PipelinesIntent_Content) _then) = _$PipelinesIntent_ContentCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, String id, PipelineContentSource source
});


$PipelineContentSourceCopyWith<$Res> get source;

}
/// @nodoc
class _$PipelinesIntent_ContentCopyWithImpl<$Res>
    implements $PipelinesIntent_ContentCopyWith<$Res> {
  _$PipelinesIntent_ContentCopyWithImpl(this._self, this._then);

  final PipelinesIntent_Content _self;
  final $Res Function(PipelinesIntent_Content) _then;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? id = null,Object? source = null,}) {
  return _then(PipelinesIntent_Content(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,source: null == source ? _self.source : source // ignore: cast_nullable_to_non_nullable
as PipelineContentSource,
  ));
}

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$PipelineContentSourceCopyWith<$Res> get source {
  
  return $PipelineContentSourceCopyWith<$Res>(_self.source, (value) {
    return _then(_self.copyWith(source: value));
  });
}
}

/// @nodoc


class PipelinesIntent_Follow extends PipelinesIntent {
  const PipelinesIntent_Follow({required this.token, this.chat, required this.online}): super._();
  

 final  int token;
 final  ChatRefView? chat;
 final  bool online;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PipelinesIntent_FollowCopyWith<PipelinesIntent_Follow> get copyWith => _$PipelinesIntent_FollowCopyWithImpl<PipelinesIntent_Follow>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesIntent_Follow&&(identical(other.token, token) || other.token == token)&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.online, online) || other.online == online));
}


@override
int get hashCode => Object.hash(runtimeType,token,chat,online);

@override
String toString() {
  return 'PipelinesIntent.follow(token: $token, chat: $chat, online: $online)';
}


}

/// @nodoc
abstract mixin class $PipelinesIntent_FollowCopyWith<$Res> implements $PipelinesIntentCopyWith<$Res> {
  factory $PipelinesIntent_FollowCopyWith(PipelinesIntent_Follow value, $Res Function(PipelinesIntent_Follow) _then) = _$PipelinesIntent_FollowCopyWithImpl;
@useResult
$Res call({
 int token, ChatRefView? chat, bool online
});




}
/// @nodoc
class _$PipelinesIntent_FollowCopyWithImpl<$Res>
    implements $PipelinesIntent_FollowCopyWith<$Res> {
  _$PipelinesIntent_FollowCopyWithImpl(this._self, this._then);

  final PipelinesIntent_Follow _self;
  final $Res Function(PipelinesIntent_Follow) _then;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? token = null,Object? chat = freezed,Object? online = null,}) {
  return _then(PipelinesIntent_Follow(
token: null == token ? _self.token : token // ignore: cast_nullable_to_non_nullable
as int,chat: freezed == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView?,online: null == online ? _self.online : online // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class PipelinesIntent_Unfollow extends PipelinesIntent {
  const PipelinesIntent_Unfollow({required this.token}): super._();
  

 final  int token;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PipelinesIntent_UnfollowCopyWith<PipelinesIntent_Unfollow> get copyWith => _$PipelinesIntent_UnfollowCopyWithImpl<PipelinesIntent_Unfollow>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesIntent_Unfollow&&(identical(other.token, token) || other.token == token));
}


@override
int get hashCode => Object.hash(runtimeType,token);

@override
String toString() {
  return 'PipelinesIntent.unfollow(token: $token)';
}


}

/// @nodoc
abstract mixin class $PipelinesIntent_UnfollowCopyWith<$Res> implements $PipelinesIntentCopyWith<$Res> {
  factory $PipelinesIntent_UnfollowCopyWith(PipelinesIntent_Unfollow value, $Res Function(PipelinesIntent_Unfollow) _then) = _$PipelinesIntent_UnfollowCopyWithImpl;
@useResult
$Res call({
 int token
});




}
/// @nodoc
class _$PipelinesIntent_UnfollowCopyWithImpl<$Res>
    implements $PipelinesIntent_UnfollowCopyWith<$Res> {
  _$PipelinesIntent_UnfollowCopyWithImpl(this._self, this._then);

  final PipelinesIntent_Unfollow _self;
  final $Res Function(PipelinesIntent_Unfollow) _then;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? token = null,}) {
  return _then(PipelinesIntent_Unfollow(
token: null == token ? _self.token : token // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}

/// @nodoc


class PipelinesIntent_DrawerUpdate extends PipelinesIntent {
  const PipelinesIntent_DrawerUpdate({required this.token, required this.chat, required this.online, required this.ready}): super._();
  

 final  int token;
 final  ChatRefView chat;
 final  bool online;
 final  bool ready;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PipelinesIntent_DrawerUpdateCopyWith<PipelinesIntent_DrawerUpdate> get copyWith => _$PipelinesIntent_DrawerUpdateCopyWithImpl<PipelinesIntent_DrawerUpdate>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesIntent_DrawerUpdate&&(identical(other.token, token) || other.token == token)&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.online, online) || other.online == online)&&(identical(other.ready, ready) || other.ready == ready));
}


@override
int get hashCode => Object.hash(runtimeType,token,chat,online,ready);

@override
String toString() {
  return 'PipelinesIntent.drawerUpdate(token: $token, chat: $chat, online: $online, ready: $ready)';
}


}

/// @nodoc
abstract mixin class $PipelinesIntent_DrawerUpdateCopyWith<$Res> implements $PipelinesIntentCopyWith<$Res> {
  factory $PipelinesIntent_DrawerUpdateCopyWith(PipelinesIntent_DrawerUpdate value, $Res Function(PipelinesIntent_DrawerUpdate) _then) = _$PipelinesIntent_DrawerUpdateCopyWithImpl;
@useResult
$Res call({
 int token, ChatRefView chat, bool online, bool ready
});




}
/// @nodoc
class _$PipelinesIntent_DrawerUpdateCopyWithImpl<$Res>
    implements $PipelinesIntent_DrawerUpdateCopyWith<$Res> {
  _$PipelinesIntent_DrawerUpdateCopyWithImpl(this._self, this._then);

  final PipelinesIntent_DrawerUpdate _self;
  final $Res Function(PipelinesIntent_DrawerUpdate) _then;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? token = null,Object? chat = null,Object? online = null,Object? ready = null,}) {
  return _then(PipelinesIntent_DrawerUpdate(
token: null == token ? _self.token : token // ignore: cast_nullable_to_non_nullable
as int,chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,online: null == online ? _self.online : online // ignore: cast_nullable_to_non_nullable
as bool,ready: null == ready ? _self.ready : ready // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class PipelinesIntent_DrawerRetry extends PipelinesIntent {
  const PipelinesIntent_DrawerRetry({required this.token}): super._();
  

 final  int token;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PipelinesIntent_DrawerRetryCopyWith<PipelinesIntent_DrawerRetry> get copyWith => _$PipelinesIntent_DrawerRetryCopyWithImpl<PipelinesIntent_DrawerRetry>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesIntent_DrawerRetry&&(identical(other.token, token) || other.token == token));
}


@override
int get hashCode => Object.hash(runtimeType,token);

@override
String toString() {
  return 'PipelinesIntent.drawerRetry(token: $token)';
}


}

/// @nodoc
abstract mixin class $PipelinesIntent_DrawerRetryCopyWith<$Res> implements $PipelinesIntentCopyWith<$Res> {
  factory $PipelinesIntent_DrawerRetryCopyWith(PipelinesIntent_DrawerRetry value, $Res Function(PipelinesIntent_DrawerRetry) _then) = _$PipelinesIntent_DrawerRetryCopyWithImpl;
@useResult
$Res call({
 int token
});




}
/// @nodoc
class _$PipelinesIntent_DrawerRetryCopyWithImpl<$Res>
    implements $PipelinesIntent_DrawerRetryCopyWith<$Res> {
  _$PipelinesIntent_DrawerRetryCopyWithImpl(this._self, this._then);

  final PipelinesIntent_DrawerRetry _self;
  final $Res Function(PipelinesIntent_DrawerRetry) _then;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? token = null,}) {
  return _then(PipelinesIntent_DrawerRetry(
token: null == token ? _self.token : token // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}

/// @nodoc


class PipelinesIntent_DrawerAct extends PipelinesIntent {
  const PipelinesIntent_DrawerAct({required this.token, required this.itemId, required this.action, required this.notifySubscriber}): super._();
  

 final  int token;
 final  String itemId;
 final  WorkAction action;
 final  bool notifySubscriber;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PipelinesIntent_DrawerActCopyWith<PipelinesIntent_DrawerAct> get copyWith => _$PipelinesIntent_DrawerActCopyWithImpl<PipelinesIntent_DrawerAct>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesIntent_DrawerAct&&(identical(other.token, token) || other.token == token)&&(identical(other.itemId, itemId) || other.itemId == itemId)&&(identical(other.action, action) || other.action == action)&&(identical(other.notifySubscriber, notifySubscriber) || other.notifySubscriber == notifySubscriber));
}


@override
int get hashCode => Object.hash(runtimeType,token,itemId,action,notifySubscriber);

@override
String toString() {
  return 'PipelinesIntent.drawerAct(token: $token, itemId: $itemId, action: $action, notifySubscriber: $notifySubscriber)';
}


}

/// @nodoc
abstract mixin class $PipelinesIntent_DrawerActCopyWith<$Res> implements $PipelinesIntentCopyWith<$Res> {
  factory $PipelinesIntent_DrawerActCopyWith(PipelinesIntent_DrawerAct value, $Res Function(PipelinesIntent_DrawerAct) _then) = _$PipelinesIntent_DrawerActCopyWithImpl;
@useResult
$Res call({
 int token, String itemId, WorkAction action, bool notifySubscriber
});




}
/// @nodoc
class _$PipelinesIntent_DrawerActCopyWithImpl<$Res>
    implements $PipelinesIntent_DrawerActCopyWith<$Res> {
  _$PipelinesIntent_DrawerActCopyWithImpl(this._self, this._then);

  final PipelinesIntent_DrawerAct _self;
  final $Res Function(PipelinesIntent_DrawerAct) _then;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? token = null,Object? itemId = null,Object? action = null,Object? notifySubscriber = null,}) {
  return _then(PipelinesIntent_DrawerAct(
token: null == token ? _self.token : token // ignore: cast_nullable_to_non_nullable
as int,itemId: null == itemId ? _self.itemId : itemId // ignore: cast_nullable_to_non_nullable
as String,action: null == action ? _self.action : action // ignore: cast_nullable_to_non_nullable
as WorkAction,notifySubscriber: null == notifySubscriber ? _self.notifySubscriber : notifySubscriber // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class PipelinesIntent_DrawerClose extends PipelinesIntent {
  const PipelinesIntent_DrawerClose({required this.token}): super._();
  

 final  int token;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PipelinesIntent_DrawerCloseCopyWith<PipelinesIntent_DrawerClose> get copyWith => _$PipelinesIntent_DrawerCloseCopyWithImpl<PipelinesIntent_DrawerClose>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesIntent_DrawerClose&&(identical(other.token, token) || other.token == token));
}


@override
int get hashCode => Object.hash(runtimeType,token);

@override
String toString() {
  return 'PipelinesIntent.drawerClose(token: $token)';
}


}

/// @nodoc
abstract mixin class $PipelinesIntent_DrawerCloseCopyWith<$Res> implements $PipelinesIntentCopyWith<$Res> {
  factory $PipelinesIntent_DrawerCloseCopyWith(PipelinesIntent_DrawerClose value, $Res Function(PipelinesIntent_DrawerClose) _then) = _$PipelinesIntent_DrawerCloseCopyWithImpl;
@useResult
$Res call({
 int token
});




}
/// @nodoc
class _$PipelinesIntent_DrawerCloseCopyWithImpl<$Res>
    implements $PipelinesIntent_DrawerCloseCopyWith<$Res> {
  _$PipelinesIntent_DrawerCloseCopyWithImpl(this._self, this._then);

  final PipelinesIntent_DrawerClose _self;
  final $Res Function(PipelinesIntent_DrawerClose) _then;

/// Create a copy of PipelinesIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? token = null,}) {
  return _then(PipelinesIntent_DrawerClose(
token: null == token ? _self.token : token // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}

/// @nodoc


class PipelinesIntent_Close extends PipelinesIntent {
  const PipelinesIntent_Close(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesIntent_Close);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'PipelinesIntent.close()';
}


}




/// @nodoc
mixin _$PipelinesOutcome {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesOutcome);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'PipelinesOutcome()';
}


}

/// @nodoc
class $PipelinesOutcomeCopyWith<$Res>  {
$PipelinesOutcomeCopyWith(PipelinesOutcome _, $Res Function(PipelinesOutcome) __);
}


/// Adds pattern-matching-related methods to [PipelinesOutcome].
extension PipelinesOutcomePatterns on PipelinesOutcome {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( PipelinesOutcome_Run value)?  run,TResult Function( PipelinesOutcome_Form value)?  form,TResult Function( PipelinesOutcome_Started value)?  started,TResult Function( PipelinesOutcome_Content value)?  content,required TResult orElse(),}){
final _that = this;
switch (_that) {
case PipelinesOutcome_Run() when run != null:
return run(_that);case PipelinesOutcome_Form() when form != null:
return form(_that);case PipelinesOutcome_Started() when started != null:
return started(_that);case PipelinesOutcome_Content() when content != null:
return content(_that);case _:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( PipelinesOutcome_Run value)  run,required TResult Function( PipelinesOutcome_Form value)  form,required TResult Function( PipelinesOutcome_Started value)  started,required TResult Function( PipelinesOutcome_Content value)  content,}){
final _that = this;
switch (_that) {
case PipelinesOutcome_Run():
return run(_that);case PipelinesOutcome_Form():
return form(_that);case PipelinesOutcome_Started():
return started(_that);case PipelinesOutcome_Content():
return content(_that);}
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( PipelinesOutcome_Run value)?  run,TResult? Function( PipelinesOutcome_Form value)?  form,TResult? Function( PipelinesOutcome_Started value)?  started,TResult? Function( PipelinesOutcome_Content value)?  content,}){
final _that = this;
switch (_that) {
case PipelinesOutcome_Run() when run != null:
return run(_that);case PipelinesOutcome_Form() when form != null:
return form(_that);case PipelinesOutcome_Started() when started != null:
return started(_that);case PipelinesOutcome_Content() when content != null:
return content(_that);case _:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( PipelineRunView? run)?  run,TResult Function( DispatchFormView form)?  form,TResult Function( String id)?  started,TResult Function( PipelineDocumentView document)?  content,required TResult orElse(),}) {final _that = this;
switch (_that) {
case PipelinesOutcome_Run() when run != null:
return run(_that.run);case PipelinesOutcome_Form() when form != null:
return form(_that.form);case PipelinesOutcome_Started() when started != null:
return started(_that.id);case PipelinesOutcome_Content() when content != null:
return content(_that.document);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( PipelineRunView? run)  run,required TResult Function( DispatchFormView form)  form,required TResult Function( String id)  started,required TResult Function( PipelineDocumentView document)  content,}) {final _that = this;
switch (_that) {
case PipelinesOutcome_Run():
return run(_that.run);case PipelinesOutcome_Form():
return form(_that.form);case PipelinesOutcome_Started():
return started(_that.id);case PipelinesOutcome_Content():
return content(_that.document);}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( PipelineRunView? run)?  run,TResult? Function( DispatchFormView form)?  form,TResult? Function( String id)?  started,TResult? Function( PipelineDocumentView document)?  content,}) {final _that = this;
switch (_that) {
case PipelinesOutcome_Run() when run != null:
return run(_that.run);case PipelinesOutcome_Form() when form != null:
return form(_that.form);case PipelinesOutcome_Started() when started != null:
return started(_that.id);case PipelinesOutcome_Content() when content != null:
return content(_that.document);case _:
  return null;

}
}

}

/// @nodoc


class PipelinesOutcome_Run extends PipelinesOutcome {
  const PipelinesOutcome_Run({this.run}): super._();
  

 final  PipelineRunView? run;

/// Create a copy of PipelinesOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PipelinesOutcome_RunCopyWith<PipelinesOutcome_Run> get copyWith => _$PipelinesOutcome_RunCopyWithImpl<PipelinesOutcome_Run>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesOutcome_Run&&(identical(other.run, run) || other.run == run));
}


@override
int get hashCode => Object.hash(runtimeType,run);

@override
String toString() {
  return 'PipelinesOutcome.run(run: $run)';
}


}

/// @nodoc
abstract mixin class $PipelinesOutcome_RunCopyWith<$Res> implements $PipelinesOutcomeCopyWith<$Res> {
  factory $PipelinesOutcome_RunCopyWith(PipelinesOutcome_Run value, $Res Function(PipelinesOutcome_Run) _then) = _$PipelinesOutcome_RunCopyWithImpl;
@useResult
$Res call({
 PipelineRunView? run
});




}
/// @nodoc
class _$PipelinesOutcome_RunCopyWithImpl<$Res>
    implements $PipelinesOutcome_RunCopyWith<$Res> {
  _$PipelinesOutcome_RunCopyWithImpl(this._self, this._then);

  final PipelinesOutcome_Run _self;
  final $Res Function(PipelinesOutcome_Run) _then;

/// Create a copy of PipelinesOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? run = freezed,}) {
  return _then(PipelinesOutcome_Run(
run: freezed == run ? _self.run : run // ignore: cast_nullable_to_non_nullable
as PipelineRunView?,
  ));
}


}

/// @nodoc


class PipelinesOutcome_Form extends PipelinesOutcome {
  const PipelinesOutcome_Form({required this.form}): super._();
  

 final  DispatchFormView form;

/// Create a copy of PipelinesOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PipelinesOutcome_FormCopyWith<PipelinesOutcome_Form> get copyWith => _$PipelinesOutcome_FormCopyWithImpl<PipelinesOutcome_Form>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesOutcome_Form&&(identical(other.form, form) || other.form == form));
}


@override
int get hashCode => Object.hash(runtimeType,form);

@override
String toString() {
  return 'PipelinesOutcome.form(form: $form)';
}


}

/// @nodoc
abstract mixin class $PipelinesOutcome_FormCopyWith<$Res> implements $PipelinesOutcomeCopyWith<$Res> {
  factory $PipelinesOutcome_FormCopyWith(PipelinesOutcome_Form value, $Res Function(PipelinesOutcome_Form) _then) = _$PipelinesOutcome_FormCopyWithImpl;
@useResult
$Res call({
 DispatchFormView form
});




}
/// @nodoc
class _$PipelinesOutcome_FormCopyWithImpl<$Res>
    implements $PipelinesOutcome_FormCopyWith<$Res> {
  _$PipelinesOutcome_FormCopyWithImpl(this._self, this._then);

  final PipelinesOutcome_Form _self;
  final $Res Function(PipelinesOutcome_Form) _then;

/// Create a copy of PipelinesOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? form = null,}) {
  return _then(PipelinesOutcome_Form(
form: null == form ? _self.form : form // ignore: cast_nullable_to_non_nullable
as DispatchFormView,
  ));
}


}

/// @nodoc


class PipelinesOutcome_Started extends PipelinesOutcome {
  const PipelinesOutcome_Started({required this.id}): super._();
  

 final  String id;

/// Create a copy of PipelinesOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PipelinesOutcome_StartedCopyWith<PipelinesOutcome_Started> get copyWith => _$PipelinesOutcome_StartedCopyWithImpl<PipelinesOutcome_Started>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesOutcome_Started&&(identical(other.id, id) || other.id == id));
}


@override
int get hashCode => Object.hash(runtimeType,id);

@override
String toString() {
  return 'PipelinesOutcome.started(id: $id)';
}


}

/// @nodoc
abstract mixin class $PipelinesOutcome_StartedCopyWith<$Res> implements $PipelinesOutcomeCopyWith<$Res> {
  factory $PipelinesOutcome_StartedCopyWith(PipelinesOutcome_Started value, $Res Function(PipelinesOutcome_Started) _then) = _$PipelinesOutcome_StartedCopyWithImpl;
@useResult
$Res call({
 String id
});




}
/// @nodoc
class _$PipelinesOutcome_StartedCopyWithImpl<$Res>
    implements $PipelinesOutcome_StartedCopyWith<$Res> {
  _$PipelinesOutcome_StartedCopyWithImpl(this._self, this._then);

  final PipelinesOutcome_Started _self;
  final $Res Function(PipelinesOutcome_Started) _then;

/// Create a copy of PipelinesOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? id = null,}) {
  return _then(PipelinesOutcome_Started(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class PipelinesOutcome_Content extends PipelinesOutcome {
  const PipelinesOutcome_Content({required this.document}): super._();
  

 final  PipelineDocumentView document;

/// Create a copy of PipelinesOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$PipelinesOutcome_ContentCopyWith<PipelinesOutcome_Content> get copyWith => _$PipelinesOutcome_ContentCopyWithImpl<PipelinesOutcome_Content>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is PipelinesOutcome_Content&&(identical(other.document, document) || other.document == document));
}


@override
int get hashCode => Object.hash(runtimeType,document);

@override
String toString() {
  return 'PipelinesOutcome.content(document: $document)';
}


}

/// @nodoc
abstract mixin class $PipelinesOutcome_ContentCopyWith<$Res> implements $PipelinesOutcomeCopyWith<$Res> {
  factory $PipelinesOutcome_ContentCopyWith(PipelinesOutcome_Content value, $Res Function(PipelinesOutcome_Content) _then) = _$PipelinesOutcome_ContentCopyWithImpl;
@useResult
$Res call({
 PipelineDocumentView document
});




}
/// @nodoc
class _$PipelinesOutcome_ContentCopyWithImpl<$Res>
    implements $PipelinesOutcome_ContentCopyWith<$Res> {
  _$PipelinesOutcome_ContentCopyWithImpl(this._self, this._then);

  final PipelinesOutcome_Content _self;
  final $Res Function(PipelinesOutcome_Content) _then;

/// Create a copy of PipelinesOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? document = null,}) {
  return _then(PipelinesOutcome_Content(
document: null == document ? _self.document : document // ignore: cast_nullable_to_non_nullable
as PipelineDocumentView,
  ));
}


}

// dart format on
