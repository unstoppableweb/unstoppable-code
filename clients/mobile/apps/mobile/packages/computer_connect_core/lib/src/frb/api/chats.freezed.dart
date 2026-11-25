// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'chats.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;
/// @nodoc
mixin _$ChatIntent {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'ChatIntent()';
}


}

/// @nodoc
class $ChatIntentCopyWith<$Res>  {
$ChatIntentCopyWith(ChatIntent _, $Res Function(ChatIntent) __);
}


/// Adds pattern-matching-related methods to [ChatIntent].
extension ChatIntentPatterns on ChatIntent {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( ChatIntent_SetConnected value)?  setConnected,TResult Function( ChatIntent_Open value)?  open,TResult Function( ChatIntent_LoadOlder value)?  loadOlder,TResult Function( ChatIntent_Leave value)?  leave,TResult Function( ChatIntent_ToggleTurn value)?  toggleTurn,TResult Function( ChatIntent_SetFooterTurns value)?  setFooterTurns,TResult Function( ChatIntent_SetReadReceipts value)?  setReadReceipts,TResult Function( ChatIntent_InvalidateReadReceipts value)?  invalidateReadReceipts,TResult Function( ChatIntent_RetryReadReceipts value)?  retryReadReceipts,TResult Function( ChatIntent_CloseTab value)?  closeTab,TResult Function( ChatIntent_Refresh value)?  refresh,TResult Function( ChatIntent_RestoreConnection value)?  restoreConnection,TResult Function( ChatIntent_TrackTurns value)?  trackTurns,TResult Function( ChatIntent_Close value)?  close,TResult Function( ChatIntent_Send value)?  send,TResult Function( ChatIntent_Stop value)?  stop,TResult Function( ChatIntent_CreateChat value)?  createChat,TResult Function( ChatIntent_CreateTab value)?  createTab,TResult Function( ChatIntent_SetWorkspaces value)?  setWorkspaces,TResult Function( ChatIntent_SetDraft value)?  setDraft,TResult Function( ChatIntent_ClearSentDraft value)?  clearSentDraft,TResult Function( ChatIntent_ImportAttachment value)?  importAttachment,TResult Function( ChatIntent_DeleteAttachment value)?  deleteAttachment,TResult Function( ChatIntent_EnableComposer value)?  enableComposer,TResult Function( ChatIntent_LoadSettings value)?  loadSettings,TResult Function( ChatIntent_SyncSettings value)?  syncSettings,TResult Function( ChatIntent_InvalidateSettings value)?  invalidateSettings,TResult Function( ChatIntent_ChangeSetting value)?  changeSetting,TResult Function( ChatIntent_InvalidatePicks value)?  invalidatePicks,TResult Function( ChatIntent_SelectModel value)?  selectModel,TResult Function( ChatIntent_PatchSettings value)?  patchSettings,TResult Function( ChatIntent_Answer value)?  answer,TResult Function( ChatIntent_DismissQuestion value)?  dismissQuestion,TResult Function( ChatIntent_Fork value)?  fork,TResult Function( ChatIntent_ForkOpened value)?  forkOpened,TResult Function( ChatIntent_LoadComposerSource value)?  loadComposerSource,required TResult orElse(),}){
final _that = this;
switch (_that) {
case ChatIntent_SetConnected() when setConnected != null:
return setConnected(_that);case ChatIntent_Open() when open != null:
return open(_that);case ChatIntent_LoadOlder() when loadOlder != null:
return loadOlder(_that);case ChatIntent_Leave() when leave != null:
return leave(_that);case ChatIntent_ToggleTurn() when toggleTurn != null:
return toggleTurn(_that);case ChatIntent_SetFooterTurns() when setFooterTurns != null:
return setFooterTurns(_that);case ChatIntent_SetReadReceipts() when setReadReceipts != null:
return setReadReceipts(_that);case ChatIntent_InvalidateReadReceipts() when invalidateReadReceipts != null:
return invalidateReadReceipts(_that);case ChatIntent_RetryReadReceipts() when retryReadReceipts != null:
return retryReadReceipts(_that);case ChatIntent_CloseTab() when closeTab != null:
return closeTab(_that);case ChatIntent_Refresh() when refresh != null:
return refresh(_that);case ChatIntent_RestoreConnection() when restoreConnection != null:
return restoreConnection(_that);case ChatIntent_TrackTurns() when trackTurns != null:
return trackTurns(_that);case ChatIntent_Close() when close != null:
return close(_that);case ChatIntent_Send() when send != null:
return send(_that);case ChatIntent_Stop() when stop != null:
return stop(_that);case ChatIntent_CreateChat() when createChat != null:
return createChat(_that);case ChatIntent_CreateTab() when createTab != null:
return createTab(_that);case ChatIntent_SetWorkspaces() when setWorkspaces != null:
return setWorkspaces(_that);case ChatIntent_SetDraft() when setDraft != null:
return setDraft(_that);case ChatIntent_ClearSentDraft() when clearSentDraft != null:
return clearSentDraft(_that);case ChatIntent_ImportAttachment() when importAttachment != null:
return importAttachment(_that);case ChatIntent_DeleteAttachment() when deleteAttachment != null:
return deleteAttachment(_that);case ChatIntent_EnableComposer() when enableComposer != null:
return enableComposer(_that);case ChatIntent_LoadSettings() when loadSettings != null:
return loadSettings(_that);case ChatIntent_SyncSettings() when syncSettings != null:
return syncSettings(_that);case ChatIntent_InvalidateSettings() when invalidateSettings != null:
return invalidateSettings(_that);case ChatIntent_ChangeSetting() when changeSetting != null:
return changeSetting(_that);case ChatIntent_InvalidatePicks() when invalidatePicks != null:
return invalidatePicks(_that);case ChatIntent_SelectModel() when selectModel != null:
return selectModel(_that);case ChatIntent_PatchSettings() when patchSettings != null:
return patchSettings(_that);case ChatIntent_Answer() when answer != null:
return answer(_that);case ChatIntent_DismissQuestion() when dismissQuestion != null:
return dismissQuestion(_that);case ChatIntent_Fork() when fork != null:
return fork(_that);case ChatIntent_ForkOpened() when forkOpened != null:
return forkOpened(_that);case ChatIntent_LoadComposerSource() when loadComposerSource != null:
return loadComposerSource(_that);case _:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( ChatIntent_SetConnected value)  setConnected,required TResult Function( ChatIntent_Open value)  open,required TResult Function( ChatIntent_LoadOlder value)  loadOlder,required TResult Function( ChatIntent_Leave value)  leave,required TResult Function( ChatIntent_ToggleTurn value)  toggleTurn,required TResult Function( ChatIntent_SetFooterTurns value)  setFooterTurns,required TResult Function( ChatIntent_SetReadReceipts value)  setReadReceipts,required TResult Function( ChatIntent_InvalidateReadReceipts value)  invalidateReadReceipts,required TResult Function( ChatIntent_RetryReadReceipts value)  retryReadReceipts,required TResult Function( ChatIntent_CloseTab value)  closeTab,required TResult Function( ChatIntent_Refresh value)  refresh,required TResult Function( ChatIntent_RestoreConnection value)  restoreConnection,required TResult Function( ChatIntent_TrackTurns value)  trackTurns,required TResult Function( ChatIntent_Close value)  close,required TResult Function( ChatIntent_Send value)  send,required TResult Function( ChatIntent_Stop value)  stop,required TResult Function( ChatIntent_CreateChat value)  createChat,required TResult Function( ChatIntent_CreateTab value)  createTab,required TResult Function( ChatIntent_SetWorkspaces value)  setWorkspaces,required TResult Function( ChatIntent_SetDraft value)  setDraft,required TResult Function( ChatIntent_ClearSentDraft value)  clearSentDraft,required TResult Function( ChatIntent_ImportAttachment value)  importAttachment,required TResult Function( ChatIntent_DeleteAttachment value)  deleteAttachment,required TResult Function( ChatIntent_EnableComposer value)  enableComposer,required TResult Function( ChatIntent_LoadSettings value)  loadSettings,required TResult Function( ChatIntent_SyncSettings value)  syncSettings,required TResult Function( ChatIntent_InvalidateSettings value)  invalidateSettings,required TResult Function( ChatIntent_ChangeSetting value)  changeSetting,required TResult Function( ChatIntent_InvalidatePicks value)  invalidatePicks,required TResult Function( ChatIntent_SelectModel value)  selectModel,required TResult Function( ChatIntent_PatchSettings value)  patchSettings,required TResult Function( ChatIntent_Answer value)  answer,required TResult Function( ChatIntent_DismissQuestion value)  dismissQuestion,required TResult Function( ChatIntent_Fork value)  fork,required TResult Function( ChatIntent_ForkOpened value)  forkOpened,required TResult Function( ChatIntent_LoadComposerSource value)  loadComposerSource,}){
final _that = this;
switch (_that) {
case ChatIntent_SetConnected():
return setConnected(_that);case ChatIntent_Open():
return open(_that);case ChatIntent_LoadOlder():
return loadOlder(_that);case ChatIntent_Leave():
return leave(_that);case ChatIntent_ToggleTurn():
return toggleTurn(_that);case ChatIntent_SetFooterTurns():
return setFooterTurns(_that);case ChatIntent_SetReadReceipts():
return setReadReceipts(_that);case ChatIntent_InvalidateReadReceipts():
return invalidateReadReceipts(_that);case ChatIntent_RetryReadReceipts():
return retryReadReceipts(_that);case ChatIntent_CloseTab():
return closeTab(_that);case ChatIntent_Refresh():
return refresh(_that);case ChatIntent_RestoreConnection():
return restoreConnection(_that);case ChatIntent_TrackTurns():
return trackTurns(_that);case ChatIntent_Close():
return close(_that);case ChatIntent_Send():
return send(_that);case ChatIntent_Stop():
return stop(_that);case ChatIntent_CreateChat():
return createChat(_that);case ChatIntent_CreateTab():
return createTab(_that);case ChatIntent_SetWorkspaces():
return setWorkspaces(_that);case ChatIntent_SetDraft():
return setDraft(_that);case ChatIntent_ClearSentDraft():
return clearSentDraft(_that);case ChatIntent_ImportAttachment():
return importAttachment(_that);case ChatIntent_DeleteAttachment():
return deleteAttachment(_that);case ChatIntent_EnableComposer():
return enableComposer(_that);case ChatIntent_LoadSettings():
return loadSettings(_that);case ChatIntent_SyncSettings():
return syncSettings(_that);case ChatIntent_InvalidateSettings():
return invalidateSettings(_that);case ChatIntent_ChangeSetting():
return changeSetting(_that);case ChatIntent_InvalidatePicks():
return invalidatePicks(_that);case ChatIntent_SelectModel():
return selectModel(_that);case ChatIntent_PatchSettings():
return patchSettings(_that);case ChatIntent_Answer():
return answer(_that);case ChatIntent_DismissQuestion():
return dismissQuestion(_that);case ChatIntent_Fork():
return fork(_that);case ChatIntent_ForkOpened():
return forkOpened(_that);case ChatIntent_LoadComposerSource():
return loadComposerSource(_that);}
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( ChatIntent_SetConnected value)?  setConnected,TResult? Function( ChatIntent_Open value)?  open,TResult? Function( ChatIntent_LoadOlder value)?  loadOlder,TResult? Function( ChatIntent_Leave value)?  leave,TResult? Function( ChatIntent_ToggleTurn value)?  toggleTurn,TResult? Function( ChatIntent_SetFooterTurns value)?  setFooterTurns,TResult? Function( ChatIntent_SetReadReceipts value)?  setReadReceipts,TResult? Function( ChatIntent_InvalidateReadReceipts value)?  invalidateReadReceipts,TResult? Function( ChatIntent_RetryReadReceipts value)?  retryReadReceipts,TResult? Function( ChatIntent_CloseTab value)?  closeTab,TResult? Function( ChatIntent_Refresh value)?  refresh,TResult? Function( ChatIntent_RestoreConnection value)?  restoreConnection,TResult? Function( ChatIntent_TrackTurns value)?  trackTurns,TResult? Function( ChatIntent_Close value)?  close,TResult? Function( ChatIntent_Send value)?  send,TResult? Function( ChatIntent_Stop value)?  stop,TResult? Function( ChatIntent_CreateChat value)?  createChat,TResult? Function( ChatIntent_CreateTab value)?  createTab,TResult? Function( ChatIntent_SetWorkspaces value)?  setWorkspaces,TResult? Function( ChatIntent_SetDraft value)?  setDraft,TResult? Function( ChatIntent_ClearSentDraft value)?  clearSentDraft,TResult? Function( ChatIntent_ImportAttachment value)?  importAttachment,TResult? Function( ChatIntent_DeleteAttachment value)?  deleteAttachment,TResult? Function( ChatIntent_EnableComposer value)?  enableComposer,TResult? Function( ChatIntent_LoadSettings value)?  loadSettings,TResult? Function( ChatIntent_SyncSettings value)?  syncSettings,TResult? Function( ChatIntent_InvalidateSettings value)?  invalidateSettings,TResult? Function( ChatIntent_ChangeSetting value)?  changeSetting,TResult? Function( ChatIntent_InvalidatePicks value)?  invalidatePicks,TResult? Function( ChatIntent_SelectModel value)?  selectModel,TResult? Function( ChatIntent_PatchSettings value)?  patchSettings,TResult? Function( ChatIntent_Answer value)?  answer,TResult? Function( ChatIntent_DismissQuestion value)?  dismissQuestion,TResult? Function( ChatIntent_Fork value)?  fork,TResult? Function( ChatIntent_ForkOpened value)?  forkOpened,TResult? Function( ChatIntent_LoadComposerSource value)?  loadComposerSource,}){
final _that = this;
switch (_that) {
case ChatIntent_SetConnected() when setConnected != null:
return setConnected(_that);case ChatIntent_Open() when open != null:
return open(_that);case ChatIntent_LoadOlder() when loadOlder != null:
return loadOlder(_that);case ChatIntent_Leave() when leave != null:
return leave(_that);case ChatIntent_ToggleTurn() when toggleTurn != null:
return toggleTurn(_that);case ChatIntent_SetFooterTurns() when setFooterTurns != null:
return setFooterTurns(_that);case ChatIntent_SetReadReceipts() when setReadReceipts != null:
return setReadReceipts(_that);case ChatIntent_InvalidateReadReceipts() when invalidateReadReceipts != null:
return invalidateReadReceipts(_that);case ChatIntent_RetryReadReceipts() when retryReadReceipts != null:
return retryReadReceipts(_that);case ChatIntent_CloseTab() when closeTab != null:
return closeTab(_that);case ChatIntent_Refresh() when refresh != null:
return refresh(_that);case ChatIntent_RestoreConnection() when restoreConnection != null:
return restoreConnection(_that);case ChatIntent_TrackTurns() when trackTurns != null:
return trackTurns(_that);case ChatIntent_Close() when close != null:
return close(_that);case ChatIntent_Send() when send != null:
return send(_that);case ChatIntent_Stop() when stop != null:
return stop(_that);case ChatIntent_CreateChat() when createChat != null:
return createChat(_that);case ChatIntent_CreateTab() when createTab != null:
return createTab(_that);case ChatIntent_SetWorkspaces() when setWorkspaces != null:
return setWorkspaces(_that);case ChatIntent_SetDraft() when setDraft != null:
return setDraft(_that);case ChatIntent_ClearSentDraft() when clearSentDraft != null:
return clearSentDraft(_that);case ChatIntent_ImportAttachment() when importAttachment != null:
return importAttachment(_that);case ChatIntent_DeleteAttachment() when deleteAttachment != null:
return deleteAttachment(_that);case ChatIntent_EnableComposer() when enableComposer != null:
return enableComposer(_that);case ChatIntent_LoadSettings() when loadSettings != null:
return loadSettings(_that);case ChatIntent_SyncSettings() when syncSettings != null:
return syncSettings(_that);case ChatIntent_InvalidateSettings() when invalidateSettings != null:
return invalidateSettings(_that);case ChatIntent_ChangeSetting() when changeSetting != null:
return changeSetting(_that);case ChatIntent_InvalidatePicks() when invalidatePicks != null:
return invalidatePicks(_that);case ChatIntent_SelectModel() when selectModel != null:
return selectModel(_that);case ChatIntent_PatchSettings() when patchSettings != null:
return patchSettings(_that);case ChatIntent_Answer() when answer != null:
return answer(_that);case ChatIntent_DismissQuestion() when dismissQuestion != null:
return dismissQuestion(_that);case ChatIntent_Fork() when fork != null:
return fork(_that);case ChatIntent_ForkOpened() when forkOpened != null:
return forkOpened(_that);case ChatIntent_LoadComposerSource() when loadComposerSource != null:
return loadComposerSource(_that);case _:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( bool connected,  int generation)?  setConnected,TResult Function( ChatRefView chat,  int generation)?  open,TResult Function()?  loadOlder,TResult Function( int? expected,  int generation)?  leave,TResult Function( String key)?  toggleTurn,TResult Function( List<String> keys)?  setFooterTurns,TResult Function( bool enabled)?  setReadReceipts,TResult Function()?  invalidateReadReceipts,TResult Function()?  retryReadReceipts,TResult Function( String id)?  closeTab,TResult Function( ChatRefView chat,  int generation)?  refresh,TResult Function( bool catalogLoaded)?  restoreConnection,TResult Function( bool enabled)?  trackTurns,TResult Function()?  close,TResult Function( ChatRefView? chat,  String text,  bool retry,  bool dictated,  List<String> attachmentPaths)?  send,TResult Function( ChatRefView chat)?  stop,TResult Function( String workspaceId,  String? title)?  createChat,TResult Function( String projectId,  String worktreeId)?  createTab,TResult Function( List<String> ids)?  setWorkspaces,TResult Function( ChatRefView chat,  String text,  int seq)?  setDraft,TResult Function( ChatRefView chat,  String text)?  clearSentDraft,TResult Function( ChatRefView scope,  String filename,  Uint8List bytes)?  importAttachment,TResult Function( ChatRefView scope,  String filename)?  deleteAttachment,TResult Function()?  enableComposer,TResult Function( bool report)?  loadSettings,TResult Function( ChatRefView chat,  String modelJson,  String harnessJson,  bool running)?  syncSettings,TResult Function()?  invalidateSettings,TResult Function( ChatRefView chat,  SettingsPick pick)?  changeSetting,TResult Function()?  invalidatePicks,TResult Function( ChatRefView chat,  String id,  String provider,  String? harness)?  selectModel,TResult Function( ChatRefView chat,  String patchJson)?  patchSettings,TResult Function( ChatRefView chat,  String requestId,  String answersJson)?  answer,TResult Function( ChatRefView chat,  String requestId)?  dismissQuestion,TResult Function( ChatRefView chat,  String atMessageId)?  fork,TResult Function( ChatRefView chat,  String atMessageId)?  forkOpened,TResult Function( ComposerSource source,  SourceScopeView scope)?  loadComposerSource,required TResult orElse(),}) {final _that = this;
switch (_that) {
case ChatIntent_SetConnected() when setConnected != null:
return setConnected(_that.connected,_that.generation);case ChatIntent_Open() when open != null:
return open(_that.chat,_that.generation);case ChatIntent_LoadOlder() when loadOlder != null:
return loadOlder();case ChatIntent_Leave() when leave != null:
return leave(_that.expected,_that.generation);case ChatIntent_ToggleTurn() when toggleTurn != null:
return toggleTurn(_that.key);case ChatIntent_SetFooterTurns() when setFooterTurns != null:
return setFooterTurns(_that.keys);case ChatIntent_SetReadReceipts() when setReadReceipts != null:
return setReadReceipts(_that.enabled);case ChatIntent_InvalidateReadReceipts() when invalidateReadReceipts != null:
return invalidateReadReceipts();case ChatIntent_RetryReadReceipts() when retryReadReceipts != null:
return retryReadReceipts();case ChatIntent_CloseTab() when closeTab != null:
return closeTab(_that.id);case ChatIntent_Refresh() when refresh != null:
return refresh(_that.chat,_that.generation);case ChatIntent_RestoreConnection() when restoreConnection != null:
return restoreConnection(_that.catalogLoaded);case ChatIntent_TrackTurns() when trackTurns != null:
return trackTurns(_that.enabled);case ChatIntent_Close() when close != null:
return close();case ChatIntent_Send() when send != null:
return send(_that.chat,_that.text,_that.retry,_that.dictated,_that.attachmentPaths);case ChatIntent_Stop() when stop != null:
return stop(_that.chat);case ChatIntent_CreateChat() when createChat != null:
return createChat(_that.workspaceId,_that.title);case ChatIntent_CreateTab() when createTab != null:
return createTab(_that.projectId,_that.worktreeId);case ChatIntent_SetWorkspaces() when setWorkspaces != null:
return setWorkspaces(_that.ids);case ChatIntent_SetDraft() when setDraft != null:
return setDraft(_that.chat,_that.text,_that.seq);case ChatIntent_ClearSentDraft() when clearSentDraft != null:
return clearSentDraft(_that.chat,_that.text);case ChatIntent_ImportAttachment() when importAttachment != null:
return importAttachment(_that.scope,_that.filename,_that.bytes);case ChatIntent_DeleteAttachment() when deleteAttachment != null:
return deleteAttachment(_that.scope,_that.filename);case ChatIntent_EnableComposer() when enableComposer != null:
return enableComposer();case ChatIntent_LoadSettings() when loadSettings != null:
return loadSettings(_that.report);case ChatIntent_SyncSettings() when syncSettings != null:
return syncSettings(_that.chat,_that.modelJson,_that.harnessJson,_that.running);case ChatIntent_InvalidateSettings() when invalidateSettings != null:
return invalidateSettings();case ChatIntent_ChangeSetting() when changeSetting != null:
return changeSetting(_that.chat,_that.pick);case ChatIntent_InvalidatePicks() when invalidatePicks != null:
return invalidatePicks();case ChatIntent_SelectModel() when selectModel != null:
return selectModel(_that.chat,_that.id,_that.provider,_that.harness);case ChatIntent_PatchSettings() when patchSettings != null:
return patchSettings(_that.chat,_that.patchJson);case ChatIntent_Answer() when answer != null:
return answer(_that.chat,_that.requestId,_that.answersJson);case ChatIntent_DismissQuestion() when dismissQuestion != null:
return dismissQuestion(_that.chat,_that.requestId);case ChatIntent_Fork() when fork != null:
return fork(_that.chat,_that.atMessageId);case ChatIntent_ForkOpened() when forkOpened != null:
return forkOpened(_that.chat,_that.atMessageId);case ChatIntent_LoadComposerSource() when loadComposerSource != null:
return loadComposerSource(_that.source,_that.scope);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( bool connected,  int generation)  setConnected,required TResult Function( ChatRefView chat,  int generation)  open,required TResult Function()  loadOlder,required TResult Function( int? expected,  int generation)  leave,required TResult Function( String key)  toggleTurn,required TResult Function( List<String> keys)  setFooterTurns,required TResult Function( bool enabled)  setReadReceipts,required TResult Function()  invalidateReadReceipts,required TResult Function()  retryReadReceipts,required TResult Function( String id)  closeTab,required TResult Function( ChatRefView chat,  int generation)  refresh,required TResult Function( bool catalogLoaded)  restoreConnection,required TResult Function( bool enabled)  trackTurns,required TResult Function()  close,required TResult Function( ChatRefView? chat,  String text,  bool retry,  bool dictated,  List<String> attachmentPaths)  send,required TResult Function( ChatRefView chat)  stop,required TResult Function( String workspaceId,  String? title)  createChat,required TResult Function( String projectId,  String worktreeId)  createTab,required TResult Function( List<String> ids)  setWorkspaces,required TResult Function( ChatRefView chat,  String text,  int seq)  setDraft,required TResult Function( ChatRefView chat,  String text)  clearSentDraft,required TResult Function( ChatRefView scope,  String filename,  Uint8List bytes)  importAttachment,required TResult Function( ChatRefView scope,  String filename)  deleteAttachment,required TResult Function()  enableComposer,required TResult Function( bool report)  loadSettings,required TResult Function( ChatRefView chat,  String modelJson,  String harnessJson,  bool running)  syncSettings,required TResult Function()  invalidateSettings,required TResult Function( ChatRefView chat,  SettingsPick pick)  changeSetting,required TResult Function()  invalidatePicks,required TResult Function( ChatRefView chat,  String id,  String provider,  String? harness)  selectModel,required TResult Function( ChatRefView chat,  String patchJson)  patchSettings,required TResult Function( ChatRefView chat,  String requestId,  String answersJson)  answer,required TResult Function( ChatRefView chat,  String requestId)  dismissQuestion,required TResult Function( ChatRefView chat,  String atMessageId)  fork,required TResult Function( ChatRefView chat,  String atMessageId)  forkOpened,required TResult Function( ComposerSource source,  SourceScopeView scope)  loadComposerSource,}) {final _that = this;
switch (_that) {
case ChatIntent_SetConnected():
return setConnected(_that.connected,_that.generation);case ChatIntent_Open():
return open(_that.chat,_that.generation);case ChatIntent_LoadOlder():
return loadOlder();case ChatIntent_Leave():
return leave(_that.expected,_that.generation);case ChatIntent_ToggleTurn():
return toggleTurn(_that.key);case ChatIntent_SetFooterTurns():
return setFooterTurns(_that.keys);case ChatIntent_SetReadReceipts():
return setReadReceipts(_that.enabled);case ChatIntent_InvalidateReadReceipts():
return invalidateReadReceipts();case ChatIntent_RetryReadReceipts():
return retryReadReceipts();case ChatIntent_CloseTab():
return closeTab(_that.id);case ChatIntent_Refresh():
return refresh(_that.chat,_that.generation);case ChatIntent_RestoreConnection():
return restoreConnection(_that.catalogLoaded);case ChatIntent_TrackTurns():
return trackTurns(_that.enabled);case ChatIntent_Close():
return close();case ChatIntent_Send():
return send(_that.chat,_that.text,_that.retry,_that.dictated,_that.attachmentPaths);case ChatIntent_Stop():
return stop(_that.chat);case ChatIntent_CreateChat():
return createChat(_that.workspaceId,_that.title);case ChatIntent_CreateTab():
return createTab(_that.projectId,_that.worktreeId);case ChatIntent_SetWorkspaces():
return setWorkspaces(_that.ids);case ChatIntent_SetDraft():
return setDraft(_that.chat,_that.text,_that.seq);case ChatIntent_ClearSentDraft():
return clearSentDraft(_that.chat,_that.text);case ChatIntent_ImportAttachment():
return importAttachment(_that.scope,_that.filename,_that.bytes);case ChatIntent_DeleteAttachment():
return deleteAttachment(_that.scope,_that.filename);case ChatIntent_EnableComposer():
return enableComposer();case ChatIntent_LoadSettings():
return loadSettings(_that.report);case ChatIntent_SyncSettings():
return syncSettings(_that.chat,_that.modelJson,_that.harnessJson,_that.running);case ChatIntent_InvalidateSettings():
return invalidateSettings();case ChatIntent_ChangeSetting():
return changeSetting(_that.chat,_that.pick);case ChatIntent_InvalidatePicks():
return invalidatePicks();case ChatIntent_SelectModel():
return selectModel(_that.chat,_that.id,_that.provider,_that.harness);case ChatIntent_PatchSettings():
return patchSettings(_that.chat,_that.patchJson);case ChatIntent_Answer():
return answer(_that.chat,_that.requestId,_that.answersJson);case ChatIntent_DismissQuestion():
return dismissQuestion(_that.chat,_that.requestId);case ChatIntent_Fork():
return fork(_that.chat,_that.atMessageId);case ChatIntent_ForkOpened():
return forkOpened(_that.chat,_that.atMessageId);case ChatIntent_LoadComposerSource():
return loadComposerSource(_that.source,_that.scope);}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( bool connected,  int generation)?  setConnected,TResult? Function( ChatRefView chat,  int generation)?  open,TResult? Function()?  loadOlder,TResult? Function( int? expected,  int generation)?  leave,TResult? Function( String key)?  toggleTurn,TResult? Function( List<String> keys)?  setFooterTurns,TResult? Function( bool enabled)?  setReadReceipts,TResult? Function()?  invalidateReadReceipts,TResult? Function()?  retryReadReceipts,TResult? Function( String id)?  closeTab,TResult? Function( ChatRefView chat,  int generation)?  refresh,TResult? Function( bool catalogLoaded)?  restoreConnection,TResult? Function( bool enabled)?  trackTurns,TResult? Function()?  close,TResult? Function( ChatRefView? chat,  String text,  bool retry,  bool dictated,  List<String> attachmentPaths)?  send,TResult? Function( ChatRefView chat)?  stop,TResult? Function( String workspaceId,  String? title)?  createChat,TResult? Function( String projectId,  String worktreeId)?  createTab,TResult? Function( List<String> ids)?  setWorkspaces,TResult? Function( ChatRefView chat,  String text,  int seq)?  setDraft,TResult? Function( ChatRefView chat,  String text)?  clearSentDraft,TResult? Function( ChatRefView scope,  String filename,  Uint8List bytes)?  importAttachment,TResult? Function( ChatRefView scope,  String filename)?  deleteAttachment,TResult? Function()?  enableComposer,TResult? Function( bool report)?  loadSettings,TResult? Function( ChatRefView chat,  String modelJson,  String harnessJson,  bool running)?  syncSettings,TResult? Function()?  invalidateSettings,TResult? Function( ChatRefView chat,  SettingsPick pick)?  changeSetting,TResult? Function()?  invalidatePicks,TResult? Function( ChatRefView chat,  String id,  String provider,  String? harness)?  selectModel,TResult? Function( ChatRefView chat,  String patchJson)?  patchSettings,TResult? Function( ChatRefView chat,  String requestId,  String answersJson)?  answer,TResult? Function( ChatRefView chat,  String requestId)?  dismissQuestion,TResult? Function( ChatRefView chat,  String atMessageId)?  fork,TResult? Function( ChatRefView chat,  String atMessageId)?  forkOpened,TResult? Function( ComposerSource source,  SourceScopeView scope)?  loadComposerSource,}) {final _that = this;
switch (_that) {
case ChatIntent_SetConnected() when setConnected != null:
return setConnected(_that.connected,_that.generation);case ChatIntent_Open() when open != null:
return open(_that.chat,_that.generation);case ChatIntent_LoadOlder() when loadOlder != null:
return loadOlder();case ChatIntent_Leave() when leave != null:
return leave(_that.expected,_that.generation);case ChatIntent_ToggleTurn() when toggleTurn != null:
return toggleTurn(_that.key);case ChatIntent_SetFooterTurns() when setFooterTurns != null:
return setFooterTurns(_that.keys);case ChatIntent_SetReadReceipts() when setReadReceipts != null:
return setReadReceipts(_that.enabled);case ChatIntent_InvalidateReadReceipts() when invalidateReadReceipts != null:
return invalidateReadReceipts();case ChatIntent_RetryReadReceipts() when retryReadReceipts != null:
return retryReadReceipts();case ChatIntent_CloseTab() when closeTab != null:
return closeTab(_that.id);case ChatIntent_Refresh() when refresh != null:
return refresh(_that.chat,_that.generation);case ChatIntent_RestoreConnection() when restoreConnection != null:
return restoreConnection(_that.catalogLoaded);case ChatIntent_TrackTurns() when trackTurns != null:
return trackTurns(_that.enabled);case ChatIntent_Close() when close != null:
return close();case ChatIntent_Send() when send != null:
return send(_that.chat,_that.text,_that.retry,_that.dictated,_that.attachmentPaths);case ChatIntent_Stop() when stop != null:
return stop(_that.chat);case ChatIntent_CreateChat() when createChat != null:
return createChat(_that.workspaceId,_that.title);case ChatIntent_CreateTab() when createTab != null:
return createTab(_that.projectId,_that.worktreeId);case ChatIntent_SetWorkspaces() when setWorkspaces != null:
return setWorkspaces(_that.ids);case ChatIntent_SetDraft() when setDraft != null:
return setDraft(_that.chat,_that.text,_that.seq);case ChatIntent_ClearSentDraft() when clearSentDraft != null:
return clearSentDraft(_that.chat,_that.text);case ChatIntent_ImportAttachment() when importAttachment != null:
return importAttachment(_that.scope,_that.filename,_that.bytes);case ChatIntent_DeleteAttachment() when deleteAttachment != null:
return deleteAttachment(_that.scope,_that.filename);case ChatIntent_EnableComposer() when enableComposer != null:
return enableComposer();case ChatIntent_LoadSettings() when loadSettings != null:
return loadSettings(_that.report);case ChatIntent_SyncSettings() when syncSettings != null:
return syncSettings(_that.chat,_that.modelJson,_that.harnessJson,_that.running);case ChatIntent_InvalidateSettings() when invalidateSettings != null:
return invalidateSettings();case ChatIntent_ChangeSetting() when changeSetting != null:
return changeSetting(_that.chat,_that.pick);case ChatIntent_InvalidatePicks() when invalidatePicks != null:
return invalidatePicks();case ChatIntent_SelectModel() when selectModel != null:
return selectModel(_that.chat,_that.id,_that.provider,_that.harness);case ChatIntent_PatchSettings() when patchSettings != null:
return patchSettings(_that.chat,_that.patchJson);case ChatIntent_Answer() when answer != null:
return answer(_that.chat,_that.requestId,_that.answersJson);case ChatIntent_DismissQuestion() when dismissQuestion != null:
return dismissQuestion(_that.chat,_that.requestId);case ChatIntent_Fork() when fork != null:
return fork(_that.chat,_that.atMessageId);case ChatIntent_ForkOpened() when forkOpened != null:
return forkOpened(_that.chat,_that.atMessageId);case ChatIntent_LoadComposerSource() when loadComposerSource != null:
return loadComposerSource(_that.source,_that.scope);case _:
  return null;

}
}

}

/// @nodoc


class ChatIntent_SetConnected extends ChatIntent {
  const ChatIntent_SetConnected({required this.connected, required this.generation}): super._();
  

 final  bool connected;
 final  int generation;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_SetConnectedCopyWith<ChatIntent_SetConnected> get copyWith => _$ChatIntent_SetConnectedCopyWithImpl<ChatIntent_SetConnected>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_SetConnected&&(identical(other.connected, connected) || other.connected == connected)&&(identical(other.generation, generation) || other.generation == generation));
}


@override
int get hashCode => Object.hash(runtimeType,connected,generation);

@override
String toString() {
  return 'ChatIntent.setConnected(connected: $connected, generation: $generation)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_SetConnectedCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_SetConnectedCopyWith(ChatIntent_SetConnected value, $Res Function(ChatIntent_SetConnected) _then) = _$ChatIntent_SetConnectedCopyWithImpl;
@useResult
$Res call({
 bool connected, int generation
});




}
/// @nodoc
class _$ChatIntent_SetConnectedCopyWithImpl<$Res>
    implements $ChatIntent_SetConnectedCopyWith<$Res> {
  _$ChatIntent_SetConnectedCopyWithImpl(this._self, this._then);

  final ChatIntent_SetConnected _self;
  final $Res Function(ChatIntent_SetConnected) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? connected = null,Object? generation = null,}) {
  return _then(ChatIntent_SetConnected(
connected: null == connected ? _self.connected : connected // ignore: cast_nullable_to_non_nullable
as bool,generation: null == generation ? _self.generation : generation // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}

/// @nodoc


class ChatIntent_Open extends ChatIntent {
  const ChatIntent_Open({required this.chat, required this.generation}): super._();
  

 final  ChatRefView chat;
 final  int generation;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_OpenCopyWith<ChatIntent_Open> get copyWith => _$ChatIntent_OpenCopyWithImpl<ChatIntent_Open>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_Open&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.generation, generation) || other.generation == generation));
}


@override
int get hashCode => Object.hash(runtimeType,chat,generation);

@override
String toString() {
  return 'ChatIntent.open(chat: $chat, generation: $generation)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_OpenCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_OpenCopyWith(ChatIntent_Open value, $Res Function(ChatIntent_Open) _then) = _$ChatIntent_OpenCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, int generation
});




}
/// @nodoc
class _$ChatIntent_OpenCopyWithImpl<$Res>
    implements $ChatIntent_OpenCopyWith<$Res> {
  _$ChatIntent_OpenCopyWithImpl(this._self, this._then);

  final ChatIntent_Open _self;
  final $Res Function(ChatIntent_Open) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? generation = null,}) {
  return _then(ChatIntent_Open(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,generation: null == generation ? _self.generation : generation // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}

/// @nodoc


class ChatIntent_LoadOlder extends ChatIntent {
  const ChatIntent_LoadOlder(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_LoadOlder);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'ChatIntent.loadOlder()';
}


}




/// @nodoc


class ChatIntent_Leave extends ChatIntent {
  const ChatIntent_Leave({this.expected, required this.generation}): super._();
  

 final  int? expected;
 final  int generation;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_LeaveCopyWith<ChatIntent_Leave> get copyWith => _$ChatIntent_LeaveCopyWithImpl<ChatIntent_Leave>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_Leave&&(identical(other.expected, expected) || other.expected == expected)&&(identical(other.generation, generation) || other.generation == generation));
}


@override
int get hashCode => Object.hash(runtimeType,expected,generation);

@override
String toString() {
  return 'ChatIntent.leave(expected: $expected, generation: $generation)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_LeaveCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_LeaveCopyWith(ChatIntent_Leave value, $Res Function(ChatIntent_Leave) _then) = _$ChatIntent_LeaveCopyWithImpl;
@useResult
$Res call({
 int? expected, int generation
});




}
/// @nodoc
class _$ChatIntent_LeaveCopyWithImpl<$Res>
    implements $ChatIntent_LeaveCopyWith<$Res> {
  _$ChatIntent_LeaveCopyWithImpl(this._self, this._then);

  final ChatIntent_Leave _self;
  final $Res Function(ChatIntent_Leave) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? expected = freezed,Object? generation = null,}) {
  return _then(ChatIntent_Leave(
expected: freezed == expected ? _self.expected : expected // ignore: cast_nullable_to_non_nullable
as int?,generation: null == generation ? _self.generation : generation // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}

/// @nodoc


class ChatIntent_ToggleTurn extends ChatIntent {
  const ChatIntent_ToggleTurn({required this.key}): super._();
  

 final  String key;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_ToggleTurnCopyWith<ChatIntent_ToggleTurn> get copyWith => _$ChatIntent_ToggleTurnCopyWithImpl<ChatIntent_ToggleTurn>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_ToggleTurn&&(identical(other.key, key) || other.key == key));
}


@override
int get hashCode => Object.hash(runtimeType,key);

@override
String toString() {
  return 'ChatIntent.toggleTurn(key: $key)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_ToggleTurnCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_ToggleTurnCopyWith(ChatIntent_ToggleTurn value, $Res Function(ChatIntent_ToggleTurn) _then) = _$ChatIntent_ToggleTurnCopyWithImpl;
@useResult
$Res call({
 String key
});




}
/// @nodoc
class _$ChatIntent_ToggleTurnCopyWithImpl<$Res>
    implements $ChatIntent_ToggleTurnCopyWith<$Res> {
  _$ChatIntent_ToggleTurnCopyWithImpl(this._self, this._then);

  final ChatIntent_ToggleTurn _self;
  final $Res Function(ChatIntent_ToggleTurn) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? key = null,}) {
  return _then(ChatIntent_ToggleTurn(
key: null == key ? _self.key : key // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class ChatIntent_SetFooterTurns extends ChatIntent {
  const ChatIntent_SetFooterTurns({required final  List<String> keys}): _keys = keys,super._();
  

 final  List<String> _keys;
 List<String> get keys {
  if (_keys is EqualUnmodifiableListView) return _keys;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_keys);
}


/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_SetFooterTurnsCopyWith<ChatIntent_SetFooterTurns> get copyWith => _$ChatIntent_SetFooterTurnsCopyWithImpl<ChatIntent_SetFooterTurns>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_SetFooterTurns&&const DeepCollectionEquality().equals(other._keys, _keys));
}


@override
int get hashCode => Object.hash(runtimeType,const DeepCollectionEquality().hash(_keys));

@override
String toString() {
  return 'ChatIntent.setFooterTurns(keys: $keys)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_SetFooterTurnsCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_SetFooterTurnsCopyWith(ChatIntent_SetFooterTurns value, $Res Function(ChatIntent_SetFooterTurns) _then) = _$ChatIntent_SetFooterTurnsCopyWithImpl;
@useResult
$Res call({
 List<String> keys
});




}
/// @nodoc
class _$ChatIntent_SetFooterTurnsCopyWithImpl<$Res>
    implements $ChatIntent_SetFooterTurnsCopyWith<$Res> {
  _$ChatIntent_SetFooterTurnsCopyWithImpl(this._self, this._then);

  final ChatIntent_SetFooterTurns _self;
  final $Res Function(ChatIntent_SetFooterTurns) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? keys = null,}) {
  return _then(ChatIntent_SetFooterTurns(
keys: null == keys ? _self._keys : keys // ignore: cast_nullable_to_non_nullable
as List<String>,
  ));
}


}

/// @nodoc


class ChatIntent_SetReadReceipts extends ChatIntent {
  const ChatIntent_SetReadReceipts({required this.enabled}): super._();
  

 final  bool enabled;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_SetReadReceiptsCopyWith<ChatIntent_SetReadReceipts> get copyWith => _$ChatIntent_SetReadReceiptsCopyWithImpl<ChatIntent_SetReadReceipts>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_SetReadReceipts&&(identical(other.enabled, enabled) || other.enabled == enabled));
}


@override
int get hashCode => Object.hash(runtimeType,enabled);

@override
String toString() {
  return 'ChatIntent.setReadReceipts(enabled: $enabled)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_SetReadReceiptsCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_SetReadReceiptsCopyWith(ChatIntent_SetReadReceipts value, $Res Function(ChatIntent_SetReadReceipts) _then) = _$ChatIntent_SetReadReceiptsCopyWithImpl;
@useResult
$Res call({
 bool enabled
});




}
/// @nodoc
class _$ChatIntent_SetReadReceiptsCopyWithImpl<$Res>
    implements $ChatIntent_SetReadReceiptsCopyWith<$Res> {
  _$ChatIntent_SetReadReceiptsCopyWithImpl(this._self, this._then);

  final ChatIntent_SetReadReceipts _self;
  final $Res Function(ChatIntent_SetReadReceipts) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? enabled = null,}) {
  return _then(ChatIntent_SetReadReceipts(
enabled: null == enabled ? _self.enabled : enabled // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class ChatIntent_InvalidateReadReceipts extends ChatIntent {
  const ChatIntent_InvalidateReadReceipts(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_InvalidateReadReceipts);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'ChatIntent.invalidateReadReceipts()';
}


}




/// @nodoc


class ChatIntent_RetryReadReceipts extends ChatIntent {
  const ChatIntent_RetryReadReceipts(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_RetryReadReceipts);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'ChatIntent.retryReadReceipts()';
}


}




/// @nodoc


class ChatIntent_CloseTab extends ChatIntent {
  const ChatIntent_CloseTab({required this.id}): super._();
  

 final  String id;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_CloseTabCopyWith<ChatIntent_CloseTab> get copyWith => _$ChatIntent_CloseTabCopyWithImpl<ChatIntent_CloseTab>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_CloseTab&&(identical(other.id, id) || other.id == id));
}


@override
int get hashCode => Object.hash(runtimeType,id);

@override
String toString() {
  return 'ChatIntent.closeTab(id: $id)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_CloseTabCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_CloseTabCopyWith(ChatIntent_CloseTab value, $Res Function(ChatIntent_CloseTab) _then) = _$ChatIntent_CloseTabCopyWithImpl;
@useResult
$Res call({
 String id
});




}
/// @nodoc
class _$ChatIntent_CloseTabCopyWithImpl<$Res>
    implements $ChatIntent_CloseTabCopyWith<$Res> {
  _$ChatIntent_CloseTabCopyWithImpl(this._self, this._then);

  final ChatIntent_CloseTab _self;
  final $Res Function(ChatIntent_CloseTab) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? id = null,}) {
  return _then(ChatIntent_CloseTab(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class ChatIntent_Refresh extends ChatIntent {
  const ChatIntent_Refresh({required this.chat, required this.generation}): super._();


 final  ChatRefView chat;
 final  int generation;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_RefreshCopyWith<ChatIntent_Refresh> get copyWith => _$ChatIntent_RefreshCopyWithImpl<ChatIntent_Refresh>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_Refresh&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.generation, generation) || other.generation == generation));
}


@override
int get hashCode => Object.hash(runtimeType,chat,generation);

@override
String toString() {
  return 'ChatIntent.refresh(chat: $chat, generation: $generation)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_RefreshCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_RefreshCopyWith(ChatIntent_Refresh value, $Res Function(ChatIntent_Refresh) _then) = _$ChatIntent_RefreshCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, int generation
});




}
/// @nodoc
class _$ChatIntent_RefreshCopyWithImpl<$Res>
    implements $ChatIntent_RefreshCopyWith<$Res> {
  _$ChatIntent_RefreshCopyWithImpl(this._self, this._then);

  final ChatIntent_Refresh _self;
  final $Res Function(ChatIntent_Refresh) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? generation = null,}) {
  return _then(ChatIntent_Refresh(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,generation: null == generation ? _self.generation : generation // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}

/// @nodoc


class ChatIntent_RestoreConnection extends ChatIntent {
  const ChatIntent_RestoreConnection({required this.catalogLoaded}): super._();


 final  bool catalogLoaded;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_RestoreConnectionCopyWith<ChatIntent_RestoreConnection> get copyWith => _$ChatIntent_RestoreConnectionCopyWithImpl<ChatIntent_RestoreConnection>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_RestoreConnection&&(identical(other.catalogLoaded, catalogLoaded) || other.catalogLoaded == catalogLoaded));
}


@override
int get hashCode => Object.hash(runtimeType,catalogLoaded);

@override
String toString() {
  return 'ChatIntent.restoreConnection(catalogLoaded: $catalogLoaded)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_RestoreConnectionCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_RestoreConnectionCopyWith(ChatIntent_RestoreConnection value, $Res Function(ChatIntent_RestoreConnection) _then) = _$ChatIntent_RestoreConnectionCopyWithImpl;
@useResult
$Res call({
 bool catalogLoaded
});




}
/// @nodoc
class _$ChatIntent_RestoreConnectionCopyWithImpl<$Res>
    implements $ChatIntent_RestoreConnectionCopyWith<$Res> {
  _$ChatIntent_RestoreConnectionCopyWithImpl(this._self, this._then);

  final ChatIntent_RestoreConnection _self;
  final $Res Function(ChatIntent_RestoreConnection) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? catalogLoaded = null,}) {
  return _then(ChatIntent_RestoreConnection(
catalogLoaded: null == catalogLoaded ? _self.catalogLoaded : catalogLoaded // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class ChatIntent_TrackTurns extends ChatIntent {
  const ChatIntent_TrackTurns({required this.enabled}): super._();


 final  bool enabled;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_TrackTurnsCopyWith<ChatIntent_TrackTurns> get copyWith => _$ChatIntent_TrackTurnsCopyWithImpl<ChatIntent_TrackTurns>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_TrackTurns&&(identical(other.enabled, enabled) || other.enabled == enabled));
}


@override
int get hashCode => Object.hash(runtimeType,enabled);

@override
String toString() {
  return 'ChatIntent.trackTurns(enabled: $enabled)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_TrackTurnsCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_TrackTurnsCopyWith(ChatIntent_TrackTurns value, $Res Function(ChatIntent_TrackTurns) _then) = _$ChatIntent_TrackTurnsCopyWithImpl;
@useResult
$Res call({
 bool enabled
});




}
/// @nodoc
class _$ChatIntent_TrackTurnsCopyWithImpl<$Res>
    implements $ChatIntent_TrackTurnsCopyWith<$Res> {
  _$ChatIntent_TrackTurnsCopyWithImpl(this._self, this._then);

  final ChatIntent_TrackTurns _self;
  final $Res Function(ChatIntent_TrackTurns) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? enabled = null,}) {
  return _then(ChatIntent_TrackTurns(
enabled: null == enabled ? _self.enabled : enabled // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class ChatIntent_Close extends ChatIntent {
  const ChatIntent_Close(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_Close);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'ChatIntent.close()';
}


}




/// @nodoc


class ChatIntent_Send extends ChatIntent {
  const ChatIntent_Send({this.chat, required this.text, required this.retry, required this.dictated, required final  List<String> attachmentPaths}): _attachmentPaths = attachmentPaths,super._();
  

/// The chat the send is for; none sends to the selected chat.
 final  ChatRefView? chat;
 final  String text;
 final  bool retry;
 final  bool dictated;
 final  List<String> _attachmentPaths;
 List<String> get attachmentPaths {
  if (_attachmentPaths is EqualUnmodifiableListView) return _attachmentPaths;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_attachmentPaths);
}


/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_SendCopyWith<ChatIntent_Send> get copyWith => _$ChatIntent_SendCopyWithImpl<ChatIntent_Send>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_Send&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.text, text) || other.text == text)&&(identical(other.retry, retry) || other.retry == retry)&&(identical(other.dictated, dictated) || other.dictated == dictated)&&const DeepCollectionEquality().equals(other._attachmentPaths, _attachmentPaths));
}


@override
int get hashCode => Object.hash(runtimeType,chat,text,retry,dictated,const DeepCollectionEquality().hash(_attachmentPaths));

@override
String toString() {
  return 'ChatIntent.send(chat: $chat, text: $text, retry: $retry, dictated: $dictated, attachmentPaths: $attachmentPaths)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_SendCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_SendCopyWith(ChatIntent_Send value, $Res Function(ChatIntent_Send) _then) = _$ChatIntent_SendCopyWithImpl;
@useResult
$Res call({
 ChatRefView? chat, String text, bool retry, bool dictated, List<String> attachmentPaths
});




}
/// @nodoc
class _$ChatIntent_SendCopyWithImpl<$Res>
    implements $ChatIntent_SendCopyWith<$Res> {
  _$ChatIntent_SendCopyWithImpl(this._self, this._then);

  final ChatIntent_Send _self;
  final $Res Function(ChatIntent_Send) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = freezed,Object? text = null,Object? retry = null,Object? dictated = null,Object? attachmentPaths = null,}) {
  return _then(ChatIntent_Send(
chat: freezed == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView?,text: null == text ? _self.text : text // ignore: cast_nullable_to_non_nullable
as String,retry: null == retry ? _self.retry : retry // ignore: cast_nullable_to_non_nullable
as bool,dictated: null == dictated ? _self.dictated : dictated // ignore: cast_nullable_to_non_nullable
as bool,attachmentPaths: null == attachmentPaths ? _self._attachmentPaths : attachmentPaths // ignore: cast_nullable_to_non_nullable
as List<String>,
  ));
}


}

/// @nodoc


class ChatIntent_Stop extends ChatIntent {
  const ChatIntent_Stop({required this.chat}): super._();
  

 final  ChatRefView chat;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_StopCopyWith<ChatIntent_Stop> get copyWith => _$ChatIntent_StopCopyWithImpl<ChatIntent_Stop>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_Stop&&(identical(other.chat, chat) || other.chat == chat));
}


@override
int get hashCode => Object.hash(runtimeType,chat);

@override
String toString() {
  return 'ChatIntent.stop(chat: $chat)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_StopCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_StopCopyWith(ChatIntent_Stop value, $Res Function(ChatIntent_Stop) _then) = _$ChatIntent_StopCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat
});




}
/// @nodoc
class _$ChatIntent_StopCopyWithImpl<$Res>
    implements $ChatIntent_StopCopyWith<$Res> {
  _$ChatIntent_StopCopyWithImpl(this._self, this._then);

  final ChatIntent_Stop _self;
  final $Res Function(ChatIntent_Stop) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,}) {
  return _then(ChatIntent_Stop(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,
  ));
}


}

/// @nodoc


class ChatIntent_CreateChat extends ChatIntent {
  const ChatIntent_CreateChat({required this.workspaceId, this.title}): super._();
  

 final  String workspaceId;
 final  String? title;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_CreateChatCopyWith<ChatIntent_CreateChat> get copyWith => _$ChatIntent_CreateChatCopyWithImpl<ChatIntent_CreateChat>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_CreateChat&&(identical(other.workspaceId, workspaceId) || other.workspaceId == workspaceId)&&(identical(other.title, title) || other.title == title));
}


@override
int get hashCode => Object.hash(runtimeType,workspaceId,title);

@override
String toString() {
  return 'ChatIntent.createChat(workspaceId: $workspaceId, title: $title)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_CreateChatCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_CreateChatCopyWith(ChatIntent_CreateChat value, $Res Function(ChatIntent_CreateChat) _then) = _$ChatIntent_CreateChatCopyWithImpl;
@useResult
$Res call({
 String workspaceId, String? title
});




}
/// @nodoc
class _$ChatIntent_CreateChatCopyWithImpl<$Res>
    implements $ChatIntent_CreateChatCopyWith<$Res> {
  _$ChatIntent_CreateChatCopyWithImpl(this._self, this._then);

  final ChatIntent_CreateChat _self;
  final $Res Function(ChatIntent_CreateChat) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? workspaceId = null,Object? title = freezed,}) {
  return _then(ChatIntent_CreateChat(
workspaceId: null == workspaceId ? _self.workspaceId : workspaceId // ignore: cast_nullable_to_non_nullable
as String,title: freezed == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}

/// @nodoc


class ChatIntent_CreateTab extends ChatIntent {
  const ChatIntent_CreateTab({required this.projectId, required this.worktreeId}): super._();
  

 final  String projectId;
 final  String worktreeId;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_CreateTabCopyWith<ChatIntent_CreateTab> get copyWith => _$ChatIntent_CreateTabCopyWithImpl<ChatIntent_CreateTab>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_CreateTab&&(identical(other.projectId, projectId) || other.projectId == projectId)&&(identical(other.worktreeId, worktreeId) || other.worktreeId == worktreeId));
}


@override
int get hashCode => Object.hash(runtimeType,projectId,worktreeId);

@override
String toString() {
  return 'ChatIntent.createTab(projectId: $projectId, worktreeId: $worktreeId)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_CreateTabCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_CreateTabCopyWith(ChatIntent_CreateTab value, $Res Function(ChatIntent_CreateTab) _then) = _$ChatIntent_CreateTabCopyWithImpl;
@useResult
$Res call({
 String projectId, String worktreeId
});




}
/// @nodoc
class _$ChatIntent_CreateTabCopyWithImpl<$Res>
    implements $ChatIntent_CreateTabCopyWith<$Res> {
  _$ChatIntent_CreateTabCopyWithImpl(this._self, this._then);

  final ChatIntent_CreateTab _self;
  final $Res Function(ChatIntent_CreateTab) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? projectId = null,Object? worktreeId = null,}) {
  return _then(ChatIntent_CreateTab(
projectId: null == projectId ? _self.projectId : projectId // ignore: cast_nullable_to_non_nullable
as String,worktreeId: null == worktreeId ? _self.worktreeId : worktreeId // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class ChatIntent_SetWorkspaces extends ChatIntent {
  const ChatIntent_SetWorkspaces({required final  List<String> ids}): _ids = ids,super._();
  

 final  List<String> _ids;
 List<String> get ids {
  if (_ids is EqualUnmodifiableListView) return _ids;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_ids);
}


/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_SetWorkspacesCopyWith<ChatIntent_SetWorkspaces> get copyWith => _$ChatIntent_SetWorkspacesCopyWithImpl<ChatIntent_SetWorkspaces>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_SetWorkspaces&&const DeepCollectionEquality().equals(other._ids, _ids));
}


@override
int get hashCode => Object.hash(runtimeType,const DeepCollectionEquality().hash(_ids));

@override
String toString() {
  return 'ChatIntent.setWorkspaces(ids: $ids)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_SetWorkspacesCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_SetWorkspacesCopyWith(ChatIntent_SetWorkspaces value, $Res Function(ChatIntent_SetWorkspaces) _then) = _$ChatIntent_SetWorkspacesCopyWithImpl;
@useResult
$Res call({
 List<String> ids
});




}
/// @nodoc
class _$ChatIntent_SetWorkspacesCopyWithImpl<$Res>
    implements $ChatIntent_SetWorkspacesCopyWith<$Res> {
  _$ChatIntent_SetWorkspacesCopyWithImpl(this._self, this._then);

  final ChatIntent_SetWorkspaces _self;
  final $Res Function(ChatIntent_SetWorkspaces) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? ids = null,}) {
  return _then(ChatIntent_SetWorkspaces(
ids: null == ids ? _self._ids : ids // ignore: cast_nullable_to_non_nullable
as List<String>,
  ));
}


}

/// @nodoc


class ChatIntent_SetDraft extends ChatIntent {
  const ChatIntent_SetDraft({required this.chat, required this.text, required this.seq}): super._();
  

 final  ChatRefView chat;
 final  String text;
 final  int seq;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_SetDraftCopyWith<ChatIntent_SetDraft> get copyWith => _$ChatIntent_SetDraftCopyWithImpl<ChatIntent_SetDraft>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_SetDraft&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.text, text) || other.text == text)&&(identical(other.seq, seq) || other.seq == seq));
}


@override
int get hashCode => Object.hash(runtimeType,chat,text,seq);

@override
String toString() {
  return 'ChatIntent.setDraft(chat: $chat, text: $text, seq: $seq)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_SetDraftCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_SetDraftCopyWith(ChatIntent_SetDraft value, $Res Function(ChatIntent_SetDraft) _then) = _$ChatIntent_SetDraftCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, String text, int seq
});




}
/// @nodoc
class _$ChatIntent_SetDraftCopyWithImpl<$Res>
    implements $ChatIntent_SetDraftCopyWith<$Res> {
  _$ChatIntent_SetDraftCopyWithImpl(this._self, this._then);

  final ChatIntent_SetDraft _self;
  final $Res Function(ChatIntent_SetDraft) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? text = null,Object? seq = null,}) {
  return _then(ChatIntent_SetDraft(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,text: null == text ? _self.text : text // ignore: cast_nullable_to_non_nullable
as String,seq: null == seq ? _self.seq : seq // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}

/// @nodoc


class ChatIntent_ClearSentDraft extends ChatIntent {
  const ChatIntent_ClearSentDraft({required this.chat, required this.text}): super._();
  

 final  ChatRefView chat;
 final  String text;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_ClearSentDraftCopyWith<ChatIntent_ClearSentDraft> get copyWith => _$ChatIntent_ClearSentDraftCopyWithImpl<ChatIntent_ClearSentDraft>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_ClearSentDraft&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.text, text) || other.text == text));
}


@override
int get hashCode => Object.hash(runtimeType,chat,text);

@override
String toString() {
  return 'ChatIntent.clearSentDraft(chat: $chat, text: $text)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_ClearSentDraftCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_ClearSentDraftCopyWith(ChatIntent_ClearSentDraft value, $Res Function(ChatIntent_ClearSentDraft) _then) = _$ChatIntent_ClearSentDraftCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, String text
});




}
/// @nodoc
class _$ChatIntent_ClearSentDraftCopyWithImpl<$Res>
    implements $ChatIntent_ClearSentDraftCopyWith<$Res> {
  _$ChatIntent_ClearSentDraftCopyWithImpl(this._self, this._then);

  final ChatIntent_ClearSentDraft _self;
  final $Res Function(ChatIntent_ClearSentDraft) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? text = null,}) {
  return _then(ChatIntent_ClearSentDraft(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,text: null == text ? _self.text : text // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class ChatIntent_ImportAttachment extends ChatIntent {
  const ChatIntent_ImportAttachment({required this.scope, required this.filename, required this.bytes}): super._();
  

 final  ChatRefView scope;
 final  String filename;
 final  Uint8List bytes;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_ImportAttachmentCopyWith<ChatIntent_ImportAttachment> get copyWith => _$ChatIntent_ImportAttachmentCopyWithImpl<ChatIntent_ImportAttachment>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_ImportAttachment&&(identical(other.scope, scope) || other.scope == scope)&&(identical(other.filename, filename) || other.filename == filename)&&const DeepCollectionEquality().equals(other.bytes, bytes));
}


@override
int get hashCode => Object.hash(runtimeType,scope,filename,const DeepCollectionEquality().hash(bytes));

@override
String toString() {
  return 'ChatIntent.importAttachment(scope: $scope, filename: $filename, bytes: $bytes)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_ImportAttachmentCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_ImportAttachmentCopyWith(ChatIntent_ImportAttachment value, $Res Function(ChatIntent_ImportAttachment) _then) = _$ChatIntent_ImportAttachmentCopyWithImpl;
@useResult
$Res call({
 ChatRefView scope, String filename, Uint8List bytes
});




}
/// @nodoc
class _$ChatIntent_ImportAttachmentCopyWithImpl<$Res>
    implements $ChatIntent_ImportAttachmentCopyWith<$Res> {
  _$ChatIntent_ImportAttachmentCopyWithImpl(this._self, this._then);

  final ChatIntent_ImportAttachment _self;
  final $Res Function(ChatIntent_ImportAttachment) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? scope = null,Object? filename = null,Object? bytes = null,}) {
  return _then(ChatIntent_ImportAttachment(
scope: null == scope ? _self.scope : scope // ignore: cast_nullable_to_non_nullable
as ChatRefView,filename: null == filename ? _self.filename : filename // ignore: cast_nullable_to_non_nullable
as String,bytes: null == bytes ? _self.bytes : bytes // ignore: cast_nullable_to_non_nullable
as Uint8List,
  ));
}


}

/// @nodoc


class ChatIntent_DeleteAttachment extends ChatIntent {
  const ChatIntent_DeleteAttachment({required this.scope, required this.filename}): super._();
  

 final  ChatRefView scope;
 final  String filename;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_DeleteAttachmentCopyWith<ChatIntent_DeleteAttachment> get copyWith => _$ChatIntent_DeleteAttachmentCopyWithImpl<ChatIntent_DeleteAttachment>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_DeleteAttachment&&(identical(other.scope, scope) || other.scope == scope)&&(identical(other.filename, filename) || other.filename == filename));
}


@override
int get hashCode => Object.hash(runtimeType,scope,filename);

@override
String toString() {
  return 'ChatIntent.deleteAttachment(scope: $scope, filename: $filename)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_DeleteAttachmentCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_DeleteAttachmentCopyWith(ChatIntent_DeleteAttachment value, $Res Function(ChatIntent_DeleteAttachment) _then) = _$ChatIntent_DeleteAttachmentCopyWithImpl;
@useResult
$Res call({
 ChatRefView scope, String filename
});




}
/// @nodoc
class _$ChatIntent_DeleteAttachmentCopyWithImpl<$Res>
    implements $ChatIntent_DeleteAttachmentCopyWith<$Res> {
  _$ChatIntent_DeleteAttachmentCopyWithImpl(this._self, this._then);

  final ChatIntent_DeleteAttachment _self;
  final $Res Function(ChatIntent_DeleteAttachment) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? scope = null,Object? filename = null,}) {
  return _then(ChatIntent_DeleteAttachment(
scope: null == scope ? _self.scope : scope // ignore: cast_nullable_to_non_nullable
as ChatRefView,filename: null == filename ? _self.filename : filename // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class ChatIntent_EnableComposer extends ChatIntent {
  const ChatIntent_EnableComposer(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_EnableComposer);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'ChatIntent.enableComposer()';
}


}




/// @nodoc


class ChatIntent_LoadSettings extends ChatIntent {
  const ChatIntent_LoadSettings({required this.report}): super._();
  

 final  bool report;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_LoadSettingsCopyWith<ChatIntent_LoadSettings> get copyWith => _$ChatIntent_LoadSettingsCopyWithImpl<ChatIntent_LoadSettings>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_LoadSettings&&(identical(other.report, report) || other.report == report));
}


@override
int get hashCode => Object.hash(runtimeType,report);

@override
String toString() {
  return 'ChatIntent.loadSettings(report: $report)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_LoadSettingsCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_LoadSettingsCopyWith(ChatIntent_LoadSettings value, $Res Function(ChatIntent_LoadSettings) _then) = _$ChatIntent_LoadSettingsCopyWithImpl;
@useResult
$Res call({
 bool report
});




}
/// @nodoc
class _$ChatIntent_LoadSettingsCopyWithImpl<$Res>
    implements $ChatIntent_LoadSettingsCopyWith<$Res> {
  _$ChatIntent_LoadSettingsCopyWithImpl(this._self, this._then);

  final ChatIntent_LoadSettings _self;
  final $Res Function(ChatIntent_LoadSettings) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? report = null,}) {
  return _then(ChatIntent_LoadSettings(
report: null == report ? _self.report : report // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class ChatIntent_SyncSettings extends ChatIntent {
  const ChatIntent_SyncSettings({required this.chat, required this.modelJson, required this.harnessJson, required this.running}): super._();
  

 final  ChatRefView chat;
 final  String modelJson;
 final  String harnessJson;
 final  bool running;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_SyncSettingsCopyWith<ChatIntent_SyncSettings> get copyWith => _$ChatIntent_SyncSettingsCopyWithImpl<ChatIntent_SyncSettings>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_SyncSettings&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.modelJson, modelJson) || other.modelJson == modelJson)&&(identical(other.harnessJson, harnessJson) || other.harnessJson == harnessJson)&&(identical(other.running, running) || other.running == running));
}


@override
int get hashCode => Object.hash(runtimeType,chat,modelJson,harnessJson,running);

@override
String toString() {
  return 'ChatIntent.syncSettings(chat: $chat, modelJson: $modelJson, harnessJson: $harnessJson, running: $running)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_SyncSettingsCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_SyncSettingsCopyWith(ChatIntent_SyncSettings value, $Res Function(ChatIntent_SyncSettings) _then) = _$ChatIntent_SyncSettingsCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, String modelJson, String harnessJson, bool running
});




}
/// @nodoc
class _$ChatIntent_SyncSettingsCopyWithImpl<$Res>
    implements $ChatIntent_SyncSettingsCopyWith<$Res> {
  _$ChatIntent_SyncSettingsCopyWithImpl(this._self, this._then);

  final ChatIntent_SyncSettings _self;
  final $Res Function(ChatIntent_SyncSettings) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? modelJson = null,Object? harnessJson = null,Object? running = null,}) {
  return _then(ChatIntent_SyncSettings(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,modelJson: null == modelJson ? _self.modelJson : modelJson // ignore: cast_nullable_to_non_nullable
as String,harnessJson: null == harnessJson ? _self.harnessJson : harnessJson // ignore: cast_nullable_to_non_nullable
as String,running: null == running ? _self.running : running // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class ChatIntent_InvalidateSettings extends ChatIntent {
  const ChatIntent_InvalidateSettings(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_InvalidateSettings);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'ChatIntent.invalidateSettings()';
}


}




/// @nodoc


class ChatIntent_ChangeSetting extends ChatIntent {
  const ChatIntent_ChangeSetting({required this.chat, required this.pick}): super._();
  

 final  ChatRefView chat;
 final  SettingsPick pick;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_ChangeSettingCopyWith<ChatIntent_ChangeSetting> get copyWith => _$ChatIntent_ChangeSettingCopyWithImpl<ChatIntent_ChangeSetting>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_ChangeSetting&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.pick, pick) || other.pick == pick));
}


@override
int get hashCode => Object.hash(runtimeType,chat,pick);

@override
String toString() {
  return 'ChatIntent.changeSetting(chat: $chat, pick: $pick)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_ChangeSettingCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_ChangeSettingCopyWith(ChatIntent_ChangeSetting value, $Res Function(ChatIntent_ChangeSetting) _then) = _$ChatIntent_ChangeSettingCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, SettingsPick pick
});


$SettingsPickCopyWith<$Res> get pick;

}
/// @nodoc
class _$ChatIntent_ChangeSettingCopyWithImpl<$Res>
    implements $ChatIntent_ChangeSettingCopyWith<$Res> {
  _$ChatIntent_ChangeSettingCopyWithImpl(this._self, this._then);

  final ChatIntent_ChangeSetting _self;
  final $Res Function(ChatIntent_ChangeSetting) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? pick = null,}) {
  return _then(ChatIntent_ChangeSetting(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,pick: null == pick ? _self.pick : pick // ignore: cast_nullable_to_non_nullable
as SettingsPick,
  ));
}

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$SettingsPickCopyWith<$Res> get pick {
  
  return $SettingsPickCopyWith<$Res>(_self.pick, (value) {
    return _then(_self.copyWith(pick: value));
  });
}
}

/// @nodoc


class ChatIntent_InvalidatePicks extends ChatIntent {
  const ChatIntent_InvalidatePicks(): super._();
  






@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_InvalidatePicks);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'ChatIntent.invalidatePicks()';
}


}




/// @nodoc


class ChatIntent_SelectModel extends ChatIntent {
  const ChatIntent_SelectModel({required this.chat, required this.id, required this.provider, this.harness}): super._();
  

 final  ChatRefView chat;
 final  String id;
 final  String provider;
 final  String? harness;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_SelectModelCopyWith<ChatIntent_SelectModel> get copyWith => _$ChatIntent_SelectModelCopyWithImpl<ChatIntent_SelectModel>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_SelectModel&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.id, id) || other.id == id)&&(identical(other.provider, provider) || other.provider == provider)&&(identical(other.harness, harness) || other.harness == harness));
}


@override
int get hashCode => Object.hash(runtimeType,chat,id,provider,harness);

@override
String toString() {
  return 'ChatIntent.selectModel(chat: $chat, id: $id, provider: $provider, harness: $harness)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_SelectModelCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_SelectModelCopyWith(ChatIntent_SelectModel value, $Res Function(ChatIntent_SelectModel) _then) = _$ChatIntent_SelectModelCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, String id, String provider, String? harness
});




}
/// @nodoc
class _$ChatIntent_SelectModelCopyWithImpl<$Res>
    implements $ChatIntent_SelectModelCopyWith<$Res> {
  _$ChatIntent_SelectModelCopyWithImpl(this._self, this._then);

  final ChatIntent_SelectModel _self;
  final $Res Function(ChatIntent_SelectModel) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? id = null,Object? provider = null,Object? harness = freezed,}) {
  return _then(ChatIntent_SelectModel(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,provider: null == provider ? _self.provider : provider // ignore: cast_nullable_to_non_nullable
as String,harness: freezed == harness ? _self.harness : harness // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}

/// @nodoc


class ChatIntent_PatchSettings extends ChatIntent {
  const ChatIntent_PatchSettings({required this.chat, required this.patchJson}): super._();
  

 final  ChatRefView chat;
 final  String patchJson;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_PatchSettingsCopyWith<ChatIntent_PatchSettings> get copyWith => _$ChatIntent_PatchSettingsCopyWithImpl<ChatIntent_PatchSettings>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_PatchSettings&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.patchJson, patchJson) || other.patchJson == patchJson));
}


@override
int get hashCode => Object.hash(runtimeType,chat,patchJson);

@override
String toString() {
  return 'ChatIntent.patchSettings(chat: $chat, patchJson: $patchJson)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_PatchSettingsCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_PatchSettingsCopyWith(ChatIntent_PatchSettings value, $Res Function(ChatIntent_PatchSettings) _then) = _$ChatIntent_PatchSettingsCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, String patchJson
});




}
/// @nodoc
class _$ChatIntent_PatchSettingsCopyWithImpl<$Res>
    implements $ChatIntent_PatchSettingsCopyWith<$Res> {
  _$ChatIntent_PatchSettingsCopyWithImpl(this._self, this._then);

  final ChatIntent_PatchSettings _self;
  final $Res Function(ChatIntent_PatchSettings) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? patchJson = null,}) {
  return _then(ChatIntent_PatchSettings(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,patchJson: null == patchJson ? _self.patchJson : patchJson // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class ChatIntent_Answer extends ChatIntent {
  const ChatIntent_Answer({required this.chat, required this.requestId, required this.answersJson}): super._();
  

 final  ChatRefView chat;
 final  String requestId;
 final  String answersJson;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_AnswerCopyWith<ChatIntent_Answer> get copyWith => _$ChatIntent_AnswerCopyWithImpl<ChatIntent_Answer>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_Answer&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.requestId, requestId) || other.requestId == requestId)&&(identical(other.answersJson, answersJson) || other.answersJson == answersJson));
}


@override
int get hashCode => Object.hash(runtimeType,chat,requestId,answersJson);

@override
String toString() {
  return 'ChatIntent.answer(chat: $chat, requestId: $requestId, answersJson: $answersJson)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_AnswerCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_AnswerCopyWith(ChatIntent_Answer value, $Res Function(ChatIntent_Answer) _then) = _$ChatIntent_AnswerCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, String requestId, String answersJson
});




}
/// @nodoc
class _$ChatIntent_AnswerCopyWithImpl<$Res>
    implements $ChatIntent_AnswerCopyWith<$Res> {
  _$ChatIntent_AnswerCopyWithImpl(this._self, this._then);

  final ChatIntent_Answer _self;
  final $Res Function(ChatIntent_Answer) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? requestId = null,Object? answersJson = null,}) {
  return _then(ChatIntent_Answer(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,requestId: null == requestId ? _self.requestId : requestId // ignore: cast_nullable_to_non_nullable
as String,answersJson: null == answersJson ? _self.answersJson : answersJson // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class ChatIntent_DismissQuestion extends ChatIntent {
  const ChatIntent_DismissQuestion({required this.chat, required this.requestId}): super._();
  

 final  ChatRefView chat;
 final  String requestId;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_DismissQuestionCopyWith<ChatIntent_DismissQuestion> get copyWith => _$ChatIntent_DismissQuestionCopyWithImpl<ChatIntent_DismissQuestion>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_DismissQuestion&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.requestId, requestId) || other.requestId == requestId));
}


@override
int get hashCode => Object.hash(runtimeType,chat,requestId);

@override
String toString() {
  return 'ChatIntent.dismissQuestion(chat: $chat, requestId: $requestId)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_DismissQuestionCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_DismissQuestionCopyWith(ChatIntent_DismissQuestion value, $Res Function(ChatIntent_DismissQuestion) _then) = _$ChatIntent_DismissQuestionCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, String requestId
});




}
/// @nodoc
class _$ChatIntent_DismissQuestionCopyWithImpl<$Res>
    implements $ChatIntent_DismissQuestionCopyWith<$Res> {
  _$ChatIntent_DismissQuestionCopyWithImpl(this._self, this._then);

  final ChatIntent_DismissQuestion _self;
  final $Res Function(ChatIntent_DismissQuestion) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? requestId = null,}) {
  return _then(ChatIntent_DismissQuestion(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,requestId: null == requestId ? _self.requestId : requestId // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class ChatIntent_Fork extends ChatIntent {
  const ChatIntent_Fork({required this.chat, required this.atMessageId}): super._();
  

 final  ChatRefView chat;
 final  String atMessageId;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_ForkCopyWith<ChatIntent_Fork> get copyWith => _$ChatIntent_ForkCopyWithImpl<ChatIntent_Fork>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_Fork&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.atMessageId, atMessageId) || other.atMessageId == atMessageId));
}


@override
int get hashCode => Object.hash(runtimeType,chat,atMessageId);

@override
String toString() {
  return 'ChatIntent.fork(chat: $chat, atMessageId: $atMessageId)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_ForkCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_ForkCopyWith(ChatIntent_Fork value, $Res Function(ChatIntent_Fork) _then) = _$ChatIntent_ForkCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, String atMessageId
});




}
/// @nodoc
class _$ChatIntent_ForkCopyWithImpl<$Res>
    implements $ChatIntent_ForkCopyWith<$Res> {
  _$ChatIntent_ForkCopyWithImpl(this._self, this._then);

  final ChatIntent_Fork _self;
  final $Res Function(ChatIntent_Fork) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? atMessageId = null,}) {
  return _then(ChatIntent_Fork(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,atMessageId: null == atMessageId ? _self.atMessageId : atMessageId // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class ChatIntent_ForkOpened extends ChatIntent {
  const ChatIntent_ForkOpened({required this.chat, required this.atMessageId}): super._();
  

 final  ChatRefView chat;
 final  String atMessageId;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_ForkOpenedCopyWith<ChatIntent_ForkOpened> get copyWith => _$ChatIntent_ForkOpenedCopyWithImpl<ChatIntent_ForkOpened>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_ForkOpened&&(identical(other.chat, chat) || other.chat == chat)&&(identical(other.atMessageId, atMessageId) || other.atMessageId == atMessageId));
}


@override
int get hashCode => Object.hash(runtimeType,chat,atMessageId);

@override
String toString() {
  return 'ChatIntent.forkOpened(chat: $chat, atMessageId: $atMessageId)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_ForkOpenedCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_ForkOpenedCopyWith(ChatIntent_ForkOpened value, $Res Function(ChatIntent_ForkOpened) _then) = _$ChatIntent_ForkOpenedCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat, String atMessageId
});




}
/// @nodoc
class _$ChatIntent_ForkOpenedCopyWithImpl<$Res>
    implements $ChatIntent_ForkOpenedCopyWith<$Res> {
  _$ChatIntent_ForkOpenedCopyWithImpl(this._self, this._then);

  final ChatIntent_ForkOpened _self;
  final $Res Function(ChatIntent_ForkOpened) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,Object? atMessageId = null,}) {
  return _then(ChatIntent_ForkOpened(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,atMessageId: null == atMessageId ? _self.atMessageId : atMessageId // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class ChatIntent_LoadComposerSource extends ChatIntent {
  const ChatIntent_LoadComposerSource({required this.source, required this.scope}): super._();
  

 final  ComposerSource source;
 final  SourceScopeView scope;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatIntent_LoadComposerSourceCopyWith<ChatIntent_LoadComposerSource> get copyWith => _$ChatIntent_LoadComposerSourceCopyWithImpl<ChatIntent_LoadComposerSource>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatIntent_LoadComposerSource&&(identical(other.source, source) || other.source == source)&&(identical(other.scope, scope) || other.scope == scope));
}


@override
int get hashCode => Object.hash(runtimeType,source,scope);

@override
String toString() {
  return 'ChatIntent.loadComposerSource(source: $source, scope: $scope)';
}


}

/// @nodoc
abstract mixin class $ChatIntent_LoadComposerSourceCopyWith<$Res> implements $ChatIntentCopyWith<$Res> {
  factory $ChatIntent_LoadComposerSourceCopyWith(ChatIntent_LoadComposerSource value, $Res Function(ChatIntent_LoadComposerSource) _then) = _$ChatIntent_LoadComposerSourceCopyWithImpl;
@useResult
$Res call({
 ComposerSource source, SourceScopeView scope
});




}
/// @nodoc
class _$ChatIntent_LoadComposerSourceCopyWithImpl<$Res>
    implements $ChatIntent_LoadComposerSourceCopyWith<$Res> {
  _$ChatIntent_LoadComposerSourceCopyWithImpl(this._self, this._then);

  final ChatIntent_LoadComposerSource _self;
  final $Res Function(ChatIntent_LoadComposerSource) _then;

/// Create a copy of ChatIntent
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? source = null,Object? scope = null,}) {
  return _then(ChatIntent_LoadComposerSource(
source: null == source ? _self.source : source // ignore: cast_nullable_to_non_nullable
as ComposerSource,scope: null == scope ? _self.scope : scope // ignore: cast_nullable_to_non_nullable
as SourceScopeView,
  ));
}


}

/// @nodoc
mixin _$ChatOutcome {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatOutcome);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'ChatOutcome()';
}


}

/// @nodoc
class $ChatOutcomeCopyWith<$Res>  {
$ChatOutcomeCopyWith(ChatOutcome _, $Res Function(ChatOutcome) __);
}


/// Adds pattern-matching-related methods to [ChatOutcome].
extension ChatOutcomePatterns on ChatOutcome {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( ChatOutcome_Opened value)?  opened,TResult Function( ChatOutcome_Sent value)?  sent,TResult Function( ChatOutcome_Created value)?  created,TResult Function( ChatOutcome_Stored value)?  stored,TResult Function( ChatOutcome_Changed value)?  changed,TResult Function( ChatOutcome_Saved value)?  saved,TResult Function( ChatOutcome_Forked value)?  forked,TResult Function( ChatOutcome_Inventory value)?  inventory,TResult Function( ChatOutcome_PluginCatalog value)?  pluginCatalog,TResult Function( ChatOutcome_Selections value)?  selections,required TResult orElse(),}){
final _that = this;
switch (_that) {
case ChatOutcome_Opened() when opened != null:
return opened(_that);case ChatOutcome_Sent() when sent != null:
return sent(_that);case ChatOutcome_Created() when created != null:
return created(_that);case ChatOutcome_Stored() when stored != null:
return stored(_that);case ChatOutcome_Changed() when changed != null:
return changed(_that);case ChatOutcome_Saved() when saved != null:
return saved(_that);case ChatOutcome_Forked() when forked != null:
return forked(_that);case ChatOutcome_Inventory() when inventory != null:
return inventory(_that);case ChatOutcome_PluginCatalog() when pluginCatalog != null:
return pluginCatalog(_that);case ChatOutcome_Selections() when selections != null:
return selections(_that);case _:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( ChatOutcome_Opened value)  opened,required TResult Function( ChatOutcome_Sent value)  sent,required TResult Function( ChatOutcome_Created value)  created,required TResult Function( ChatOutcome_Stored value)  stored,required TResult Function( ChatOutcome_Changed value)  changed,required TResult Function( ChatOutcome_Saved value)  saved,required TResult Function( ChatOutcome_Forked value)  forked,required TResult Function( ChatOutcome_Inventory value)  inventory,required TResult Function( ChatOutcome_PluginCatalog value)  pluginCatalog,required TResult Function( ChatOutcome_Selections value)  selections,}){
final _that = this;
switch (_that) {
case ChatOutcome_Opened():
return opened(_that);case ChatOutcome_Sent():
return sent(_that);case ChatOutcome_Created():
return created(_that);case ChatOutcome_Stored():
return stored(_that);case ChatOutcome_Changed():
return changed(_that);case ChatOutcome_Saved():
return saved(_that);case ChatOutcome_Forked():
return forked(_that);case ChatOutcome_Inventory():
return inventory(_that);case ChatOutcome_PluginCatalog():
return pluginCatalog(_that);case ChatOutcome_Selections():
return selections(_that);}
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( ChatOutcome_Opened value)?  opened,TResult? Function( ChatOutcome_Sent value)?  sent,TResult? Function( ChatOutcome_Created value)?  created,TResult? Function( ChatOutcome_Stored value)?  stored,TResult? Function( ChatOutcome_Changed value)?  changed,TResult? Function( ChatOutcome_Saved value)?  saved,TResult? Function( ChatOutcome_Forked value)?  forked,TResult? Function( ChatOutcome_Inventory value)?  inventory,TResult? Function( ChatOutcome_PluginCatalog value)?  pluginCatalog,TResult? Function( ChatOutcome_Selections value)?  selections,}){
final _that = this;
switch (_that) {
case ChatOutcome_Opened() when opened != null:
return opened(_that);case ChatOutcome_Sent() when sent != null:
return sent(_that);case ChatOutcome_Created() when created != null:
return created(_that);case ChatOutcome_Stored() when stored != null:
return stored(_that);case ChatOutcome_Changed() when changed != null:
return changed(_that);case ChatOutcome_Saved() when saved != null:
return saved(_that);case ChatOutcome_Forked() when forked != null:
return forked(_that);case ChatOutcome_Inventory() when inventory != null:
return inventory(_that);case ChatOutcome_PluginCatalog() when pluginCatalog != null:
return pluginCatalog(_that);case ChatOutcome_Selections() when selections != null:
return selections(_that);case _:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( bool selected,  int generation)?  opened,TResult Function( bool accepted)?  sent,TResult Function( ChatRefView chat)?  created,TResult Function( String filename,  String path,  int size)?  stored,TResult Function( bool applied)?  changed,TResult Function( int revision)?  saved,TResult Function( ChatRefView chat)?  forked,TResult Function( List<CommandRowView> commands,  bool unsettled)?  inventory,TResult Function( String json)?  pluginCatalog,TResult Function( String? json)?  selections,required TResult orElse(),}) {final _that = this;
switch (_that) {
case ChatOutcome_Opened() when opened != null:
return opened(_that.selected,_that.generation);case ChatOutcome_Sent() when sent != null:
return sent(_that.accepted);case ChatOutcome_Created() when created != null:
return created(_that.chat);case ChatOutcome_Stored() when stored != null:
return stored(_that.filename,_that.path,_that.size);case ChatOutcome_Changed() when changed != null:
return changed(_that.applied);case ChatOutcome_Saved() when saved != null:
return saved(_that.revision);case ChatOutcome_Forked() when forked != null:
return forked(_that.chat);case ChatOutcome_Inventory() when inventory != null:
return inventory(_that.commands,_that.unsettled);case ChatOutcome_PluginCatalog() when pluginCatalog != null:
return pluginCatalog(_that.json);case ChatOutcome_Selections() when selections != null:
return selections(_that.json);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( bool selected,  int generation)  opened,required TResult Function( bool accepted)  sent,required TResult Function( ChatRefView chat)  created,required TResult Function( String filename,  String path,  int size)  stored,required TResult Function( bool applied)  changed,required TResult Function( int revision)  saved,required TResult Function( ChatRefView chat)  forked,required TResult Function( List<CommandRowView> commands,  bool unsettled)  inventory,required TResult Function( String json)  pluginCatalog,required TResult Function( String? json)  selections,}) {final _that = this;
switch (_that) {
case ChatOutcome_Opened():
return opened(_that.selected,_that.generation);case ChatOutcome_Sent():
return sent(_that.accepted);case ChatOutcome_Created():
return created(_that.chat);case ChatOutcome_Stored():
return stored(_that.filename,_that.path,_that.size);case ChatOutcome_Changed():
return changed(_that.applied);case ChatOutcome_Saved():
return saved(_that.revision);case ChatOutcome_Forked():
return forked(_that.chat);case ChatOutcome_Inventory():
return inventory(_that.commands,_that.unsettled);case ChatOutcome_PluginCatalog():
return pluginCatalog(_that.json);case ChatOutcome_Selections():
return selections(_that.json);}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( bool selected,  int generation)?  opened,TResult? Function( bool accepted)?  sent,TResult? Function( ChatRefView chat)?  created,TResult? Function( String filename,  String path,  int size)?  stored,TResult? Function( bool applied)?  changed,TResult? Function( int revision)?  saved,TResult? Function( ChatRefView chat)?  forked,TResult? Function( List<CommandRowView> commands,  bool unsettled)?  inventory,TResult? Function( String json)?  pluginCatalog,TResult? Function( String? json)?  selections,}) {final _that = this;
switch (_that) {
case ChatOutcome_Opened() when opened != null:
return opened(_that.selected,_that.generation);case ChatOutcome_Sent() when sent != null:
return sent(_that.accepted);case ChatOutcome_Created() when created != null:
return created(_that.chat);case ChatOutcome_Stored() when stored != null:
return stored(_that.filename,_that.path,_that.size);case ChatOutcome_Changed() when changed != null:
return changed(_that.applied);case ChatOutcome_Saved() when saved != null:
return saved(_that.revision);case ChatOutcome_Forked() when forked != null:
return forked(_that.chat);case ChatOutcome_Inventory() when inventory != null:
return inventory(_that.commands,_that.unsettled);case ChatOutcome_PluginCatalog() when pluginCatalog != null:
return pluginCatalog(_that.json);case ChatOutcome_Selections() when selections != null:
return selections(_that.json);case _:
  return null;

}
}

}

/// @nodoc


class ChatOutcome_Opened extends ChatOutcome {
  const ChatOutcome_Opened({required this.selected, required this.generation}): super._();


 final  bool selected;
 final  int generation;

/// Create a copy of ChatOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatOutcome_OpenedCopyWith<ChatOutcome_Opened> get copyWith => _$ChatOutcome_OpenedCopyWithImpl<ChatOutcome_Opened>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatOutcome_Opened&&(identical(other.selected, selected) || other.selected == selected)&&(identical(other.generation, generation) || other.generation == generation));
}


@override
int get hashCode => Object.hash(runtimeType,selected,generation);

@override
String toString() {
  return 'ChatOutcome.opened(selected: $selected, generation: $generation)';
}


}

/// @nodoc
abstract mixin class $ChatOutcome_OpenedCopyWith<$Res> implements $ChatOutcomeCopyWith<$Res> {
  factory $ChatOutcome_OpenedCopyWith(ChatOutcome_Opened value, $Res Function(ChatOutcome_Opened) _then) = _$ChatOutcome_OpenedCopyWithImpl;
@useResult
$Res call({
 bool selected, int generation
});




}
/// @nodoc
class _$ChatOutcome_OpenedCopyWithImpl<$Res>
    implements $ChatOutcome_OpenedCopyWith<$Res> {
  _$ChatOutcome_OpenedCopyWithImpl(this._self, this._then);

  final ChatOutcome_Opened _self;
  final $Res Function(ChatOutcome_Opened) _then;

/// Create a copy of ChatOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? selected = null,Object? generation = null,}) {
  return _then(ChatOutcome_Opened(
selected: null == selected ? _self.selected : selected // ignore: cast_nullable_to_non_nullable
as bool,generation: null == generation ? _self.generation : generation // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}

/// @nodoc


class ChatOutcome_Sent extends ChatOutcome {
  const ChatOutcome_Sent({required this.accepted}): super._();
  

 final  bool accepted;

/// Create a copy of ChatOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatOutcome_SentCopyWith<ChatOutcome_Sent> get copyWith => _$ChatOutcome_SentCopyWithImpl<ChatOutcome_Sent>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatOutcome_Sent&&(identical(other.accepted, accepted) || other.accepted == accepted));
}


@override
int get hashCode => Object.hash(runtimeType,accepted);

@override
String toString() {
  return 'ChatOutcome.sent(accepted: $accepted)';
}


}

/// @nodoc
abstract mixin class $ChatOutcome_SentCopyWith<$Res> implements $ChatOutcomeCopyWith<$Res> {
  factory $ChatOutcome_SentCopyWith(ChatOutcome_Sent value, $Res Function(ChatOutcome_Sent) _then) = _$ChatOutcome_SentCopyWithImpl;
@useResult
$Res call({
 bool accepted
});




}
/// @nodoc
class _$ChatOutcome_SentCopyWithImpl<$Res>
    implements $ChatOutcome_SentCopyWith<$Res> {
  _$ChatOutcome_SentCopyWithImpl(this._self, this._then);

  final ChatOutcome_Sent _self;
  final $Res Function(ChatOutcome_Sent) _then;

/// Create a copy of ChatOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? accepted = null,}) {
  return _then(ChatOutcome_Sent(
accepted: null == accepted ? _self.accepted : accepted // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class ChatOutcome_Created extends ChatOutcome {
  const ChatOutcome_Created({required this.chat}): super._();
  

 final  ChatRefView chat;

/// Create a copy of ChatOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatOutcome_CreatedCopyWith<ChatOutcome_Created> get copyWith => _$ChatOutcome_CreatedCopyWithImpl<ChatOutcome_Created>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatOutcome_Created&&(identical(other.chat, chat) || other.chat == chat));
}


@override
int get hashCode => Object.hash(runtimeType,chat);

@override
String toString() {
  return 'ChatOutcome.created(chat: $chat)';
}


}

/// @nodoc
abstract mixin class $ChatOutcome_CreatedCopyWith<$Res> implements $ChatOutcomeCopyWith<$Res> {
  factory $ChatOutcome_CreatedCopyWith(ChatOutcome_Created value, $Res Function(ChatOutcome_Created) _then) = _$ChatOutcome_CreatedCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat
});




}
/// @nodoc
class _$ChatOutcome_CreatedCopyWithImpl<$Res>
    implements $ChatOutcome_CreatedCopyWith<$Res> {
  _$ChatOutcome_CreatedCopyWithImpl(this._self, this._then);

  final ChatOutcome_Created _self;
  final $Res Function(ChatOutcome_Created) _then;

/// Create a copy of ChatOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,}) {
  return _then(ChatOutcome_Created(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,
  ));
}


}

/// @nodoc


class ChatOutcome_Stored extends ChatOutcome {
  const ChatOutcome_Stored({required this.filename, required this.path, required this.size}): super._();
  

 final  String filename;
 final  String path;
 final  int size;

/// Create a copy of ChatOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatOutcome_StoredCopyWith<ChatOutcome_Stored> get copyWith => _$ChatOutcome_StoredCopyWithImpl<ChatOutcome_Stored>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatOutcome_Stored&&(identical(other.filename, filename) || other.filename == filename)&&(identical(other.path, path) || other.path == path)&&(identical(other.size, size) || other.size == size));
}


@override
int get hashCode => Object.hash(runtimeType,filename,path,size);

@override
String toString() {
  return 'ChatOutcome.stored(filename: $filename, path: $path, size: $size)';
}


}

/// @nodoc
abstract mixin class $ChatOutcome_StoredCopyWith<$Res> implements $ChatOutcomeCopyWith<$Res> {
  factory $ChatOutcome_StoredCopyWith(ChatOutcome_Stored value, $Res Function(ChatOutcome_Stored) _then) = _$ChatOutcome_StoredCopyWithImpl;
@useResult
$Res call({
 String filename, String path, int size
});




}
/// @nodoc
class _$ChatOutcome_StoredCopyWithImpl<$Res>
    implements $ChatOutcome_StoredCopyWith<$Res> {
  _$ChatOutcome_StoredCopyWithImpl(this._self, this._then);

  final ChatOutcome_Stored _self;
  final $Res Function(ChatOutcome_Stored) _then;

/// Create a copy of ChatOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? filename = null,Object? path = null,Object? size = null,}) {
  return _then(ChatOutcome_Stored(
filename: null == filename ? _self.filename : filename // ignore: cast_nullable_to_non_nullable
as String,path: null == path ? _self.path : path // ignore: cast_nullable_to_non_nullable
as String,size: null == size ? _self.size : size // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}

/// @nodoc


class ChatOutcome_Changed extends ChatOutcome {
  const ChatOutcome_Changed({required this.applied}): super._();
  

 final  bool applied;

/// Create a copy of ChatOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatOutcome_ChangedCopyWith<ChatOutcome_Changed> get copyWith => _$ChatOutcome_ChangedCopyWithImpl<ChatOutcome_Changed>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatOutcome_Changed&&(identical(other.applied, applied) || other.applied == applied));
}


@override
int get hashCode => Object.hash(runtimeType,applied);

@override
String toString() {
  return 'ChatOutcome.changed(applied: $applied)';
}


}

/// @nodoc
abstract mixin class $ChatOutcome_ChangedCopyWith<$Res> implements $ChatOutcomeCopyWith<$Res> {
  factory $ChatOutcome_ChangedCopyWith(ChatOutcome_Changed value, $Res Function(ChatOutcome_Changed) _then) = _$ChatOutcome_ChangedCopyWithImpl;
@useResult
$Res call({
 bool applied
});




}
/// @nodoc
class _$ChatOutcome_ChangedCopyWithImpl<$Res>
    implements $ChatOutcome_ChangedCopyWith<$Res> {
  _$ChatOutcome_ChangedCopyWithImpl(this._self, this._then);

  final ChatOutcome_Changed _self;
  final $Res Function(ChatOutcome_Changed) _then;

/// Create a copy of ChatOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? applied = null,}) {
  return _then(ChatOutcome_Changed(
applied: null == applied ? _self.applied : applied // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class ChatOutcome_Saved extends ChatOutcome {
  const ChatOutcome_Saved({required this.revision}): super._();
  

 final  int revision;

/// Create a copy of ChatOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatOutcome_SavedCopyWith<ChatOutcome_Saved> get copyWith => _$ChatOutcome_SavedCopyWithImpl<ChatOutcome_Saved>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatOutcome_Saved&&(identical(other.revision, revision) || other.revision == revision));
}


@override
int get hashCode => Object.hash(runtimeType,revision);

@override
String toString() {
  return 'ChatOutcome.saved(revision: $revision)';
}


}

/// @nodoc
abstract mixin class $ChatOutcome_SavedCopyWith<$Res> implements $ChatOutcomeCopyWith<$Res> {
  factory $ChatOutcome_SavedCopyWith(ChatOutcome_Saved value, $Res Function(ChatOutcome_Saved) _then) = _$ChatOutcome_SavedCopyWithImpl;
@useResult
$Res call({
 int revision
});




}
/// @nodoc
class _$ChatOutcome_SavedCopyWithImpl<$Res>
    implements $ChatOutcome_SavedCopyWith<$Res> {
  _$ChatOutcome_SavedCopyWithImpl(this._self, this._then);

  final ChatOutcome_Saved _self;
  final $Res Function(ChatOutcome_Saved) _then;

/// Create a copy of ChatOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? revision = null,}) {
  return _then(ChatOutcome_Saved(
revision: null == revision ? _self.revision : revision // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}

/// @nodoc


class ChatOutcome_Forked extends ChatOutcome {
  const ChatOutcome_Forked({required this.chat}): super._();
  

 final  ChatRefView chat;

/// Create a copy of ChatOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatOutcome_ForkedCopyWith<ChatOutcome_Forked> get copyWith => _$ChatOutcome_ForkedCopyWithImpl<ChatOutcome_Forked>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatOutcome_Forked&&(identical(other.chat, chat) || other.chat == chat));
}


@override
int get hashCode => Object.hash(runtimeType,chat);

@override
String toString() {
  return 'ChatOutcome.forked(chat: $chat)';
}


}

/// @nodoc
abstract mixin class $ChatOutcome_ForkedCopyWith<$Res> implements $ChatOutcomeCopyWith<$Res> {
  factory $ChatOutcome_ForkedCopyWith(ChatOutcome_Forked value, $Res Function(ChatOutcome_Forked) _then) = _$ChatOutcome_ForkedCopyWithImpl;
@useResult
$Res call({
 ChatRefView chat
});




}
/// @nodoc
class _$ChatOutcome_ForkedCopyWithImpl<$Res>
    implements $ChatOutcome_ForkedCopyWith<$Res> {
  _$ChatOutcome_ForkedCopyWithImpl(this._self, this._then);

  final ChatOutcome_Forked _self;
  final $Res Function(ChatOutcome_Forked) _then;

/// Create a copy of ChatOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? chat = null,}) {
  return _then(ChatOutcome_Forked(
chat: null == chat ? _self.chat : chat // ignore: cast_nullable_to_non_nullable
as ChatRefView,
  ));
}


}

/// @nodoc


class ChatOutcome_Inventory extends ChatOutcome {
  const ChatOutcome_Inventory({required final  List<CommandRowView> commands, required this.unsettled}): _commands = commands,super._();
  

 final  List<CommandRowView> _commands;
 List<CommandRowView> get commands {
  if (_commands is EqualUnmodifiableListView) return _commands;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_commands);
}

 final  bool unsettled;

/// Create a copy of ChatOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatOutcome_InventoryCopyWith<ChatOutcome_Inventory> get copyWith => _$ChatOutcome_InventoryCopyWithImpl<ChatOutcome_Inventory>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatOutcome_Inventory&&const DeepCollectionEquality().equals(other._commands, _commands)&&(identical(other.unsettled, unsettled) || other.unsettled == unsettled));
}


@override
int get hashCode => Object.hash(runtimeType,const DeepCollectionEquality().hash(_commands),unsettled);

@override
String toString() {
  return 'ChatOutcome.inventory(commands: $commands, unsettled: $unsettled)';
}


}

/// @nodoc
abstract mixin class $ChatOutcome_InventoryCopyWith<$Res> implements $ChatOutcomeCopyWith<$Res> {
  factory $ChatOutcome_InventoryCopyWith(ChatOutcome_Inventory value, $Res Function(ChatOutcome_Inventory) _then) = _$ChatOutcome_InventoryCopyWithImpl;
@useResult
$Res call({
 List<CommandRowView> commands, bool unsettled
});




}
/// @nodoc
class _$ChatOutcome_InventoryCopyWithImpl<$Res>
    implements $ChatOutcome_InventoryCopyWith<$Res> {
  _$ChatOutcome_InventoryCopyWithImpl(this._self, this._then);

  final ChatOutcome_Inventory _self;
  final $Res Function(ChatOutcome_Inventory) _then;

/// Create a copy of ChatOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? commands = null,Object? unsettled = null,}) {
  return _then(ChatOutcome_Inventory(
commands: null == commands ? _self._commands : commands // ignore: cast_nullable_to_non_nullable
as List<CommandRowView>,unsettled: null == unsettled ? _self.unsettled : unsettled // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class ChatOutcome_PluginCatalog extends ChatOutcome {
  const ChatOutcome_PluginCatalog({required this.json}): super._();
  

 final  String json;

/// Create a copy of ChatOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatOutcome_PluginCatalogCopyWith<ChatOutcome_PluginCatalog> get copyWith => _$ChatOutcome_PluginCatalogCopyWithImpl<ChatOutcome_PluginCatalog>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatOutcome_PluginCatalog&&(identical(other.json, json) || other.json == json));
}


@override
int get hashCode => Object.hash(runtimeType,json);

@override
String toString() {
  return 'ChatOutcome.pluginCatalog(json: $json)';
}


}

/// @nodoc
abstract mixin class $ChatOutcome_PluginCatalogCopyWith<$Res> implements $ChatOutcomeCopyWith<$Res> {
  factory $ChatOutcome_PluginCatalogCopyWith(ChatOutcome_PluginCatalog value, $Res Function(ChatOutcome_PluginCatalog) _then) = _$ChatOutcome_PluginCatalogCopyWithImpl;
@useResult
$Res call({
 String json
});




}
/// @nodoc
class _$ChatOutcome_PluginCatalogCopyWithImpl<$Res>
    implements $ChatOutcome_PluginCatalogCopyWith<$Res> {
  _$ChatOutcome_PluginCatalogCopyWithImpl(this._self, this._then);

  final ChatOutcome_PluginCatalog _self;
  final $Res Function(ChatOutcome_PluginCatalog) _then;

/// Create a copy of ChatOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? json = null,}) {
  return _then(ChatOutcome_PluginCatalog(
json: null == json ? _self.json : json // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class ChatOutcome_Selections extends ChatOutcome {
  const ChatOutcome_Selections({this.json}): super._();
  

 final  String? json;

/// Create a copy of ChatOutcome
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ChatOutcome_SelectionsCopyWith<ChatOutcome_Selections> get copyWith => _$ChatOutcome_SelectionsCopyWithImpl<ChatOutcome_Selections>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ChatOutcome_Selections&&(identical(other.json, json) || other.json == json));
}


@override
int get hashCode => Object.hash(runtimeType,json);

@override
String toString() {
  return 'ChatOutcome.selections(json: $json)';
}


}

/// @nodoc
abstract mixin class $ChatOutcome_SelectionsCopyWith<$Res> implements $ChatOutcomeCopyWith<$Res> {
  factory $ChatOutcome_SelectionsCopyWith(ChatOutcome_Selections value, $Res Function(ChatOutcome_Selections) _then) = _$ChatOutcome_SelectionsCopyWithImpl;
@useResult
$Res call({
 String? json
});




}
/// @nodoc
class _$ChatOutcome_SelectionsCopyWithImpl<$Res>
    implements $ChatOutcome_SelectionsCopyWith<$Res> {
  _$ChatOutcome_SelectionsCopyWithImpl(this._self, this._then);

  final ChatOutcome_Selections _self;
  final $Res Function(ChatOutcome_Selections) _then;

/// Create a copy of ChatOutcome
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? json = freezed,}) {
  return _then(ChatOutcome_Selections(
json: freezed == json ? _self.json : json // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}

/// @nodoc
mixin _$FeedOp {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is FeedOp);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'FeedOp()';
}


}

/// @nodoc
class $FeedOpCopyWith<$Res>  {
$FeedOpCopyWith(FeedOp _, $Res Function(FeedOp) __);
}


/// Adds pattern-matching-related methods to [FeedOp].
extension FeedOpPatterns on FeedOp {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( FeedOp_Upsert value)?  upsert,TResult Function( FeedOp_Remove value)?  remove,required TResult orElse(),}){
final _that = this;
switch (_that) {
case FeedOp_Upsert() when upsert != null:
return upsert(_that);case FeedOp_Remove() when remove != null:
return remove(_that);case _:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( FeedOp_Upsert value)  upsert,required TResult Function( FeedOp_Remove value)  remove,}){
final _that = this;
switch (_that) {
case FeedOp_Upsert():
return upsert(_that);case FeedOp_Remove():
return remove(_that);}
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( FeedOp_Upsert value)?  upsert,TResult? Function( FeedOp_Remove value)?  remove,}){
final _that = this;
switch (_that) {
case FeedOp_Upsert() when upsert != null:
return upsert(_that);case FeedOp_Remove() when remove != null:
return remove(_that);case _:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( String? after,  FeedItem item)?  upsert,TResult Function( String key)?  remove,required TResult orElse(),}) {final _that = this;
switch (_that) {
case FeedOp_Upsert() when upsert != null:
return upsert(_that.after,_that.item);case FeedOp_Remove() when remove != null:
return remove(_that.key);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( String? after,  FeedItem item)  upsert,required TResult Function( String key)  remove,}) {final _that = this;
switch (_that) {
case FeedOp_Upsert():
return upsert(_that.after,_that.item);case FeedOp_Remove():
return remove(_that.key);}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( String? after,  FeedItem item)?  upsert,TResult? Function( String key)?  remove,}) {final _that = this;
switch (_that) {
case FeedOp_Upsert() when upsert != null:
return upsert(_that.after,_that.item);case FeedOp_Remove() when remove != null:
return remove(_that.key);case _:
  return null;

}
}

}

/// @nodoc


class FeedOp_Upsert extends FeedOp {
  const FeedOp_Upsert({this.after, required this.item}): super._();
  

 final  String? after;
 final  FeedItem item;

/// Create a copy of FeedOp
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$FeedOp_UpsertCopyWith<FeedOp_Upsert> get copyWith => _$FeedOp_UpsertCopyWithImpl<FeedOp_Upsert>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is FeedOp_Upsert&&(identical(other.after, after) || other.after == after)&&(identical(other.item, item) || other.item == item));
}


@override
int get hashCode => Object.hash(runtimeType,after,item);

@override
String toString() {
  return 'FeedOp.upsert(after: $after, item: $item)';
}


}

/// @nodoc
abstract mixin class $FeedOp_UpsertCopyWith<$Res> implements $FeedOpCopyWith<$Res> {
  factory $FeedOp_UpsertCopyWith(FeedOp_Upsert value, $Res Function(FeedOp_Upsert) _then) = _$FeedOp_UpsertCopyWithImpl;
@useResult
$Res call({
 String? after, FeedItem item
});




}
/// @nodoc
class _$FeedOp_UpsertCopyWithImpl<$Res>
    implements $FeedOp_UpsertCopyWith<$Res> {
  _$FeedOp_UpsertCopyWithImpl(this._self, this._then);

  final FeedOp_Upsert _self;
  final $Res Function(FeedOp_Upsert) _then;

/// Create a copy of FeedOp
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? after = freezed,Object? item = null,}) {
  return _then(FeedOp_Upsert(
after: freezed == after ? _self.after : after // ignore: cast_nullable_to_non_nullable
as String?,item: null == item ? _self.item : item // ignore: cast_nullable_to_non_nullable
as FeedItem,
  ));
}


}

/// @nodoc


class FeedOp_Remove extends FeedOp {
  const FeedOp_Remove({required this.key}): super._();
  

 final  String key;

/// Create a copy of FeedOp
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$FeedOp_RemoveCopyWith<FeedOp_Remove> get copyWith => _$FeedOp_RemoveCopyWithImpl<FeedOp_Remove>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is FeedOp_Remove&&(identical(other.key, key) || other.key == key));
}


@override
int get hashCode => Object.hash(runtimeType,key);

@override
String toString() {
  return 'FeedOp.remove(key: $key)';
}


}

/// @nodoc
abstract mixin class $FeedOp_RemoveCopyWith<$Res> implements $FeedOpCopyWith<$Res> {
  factory $FeedOp_RemoveCopyWith(FeedOp_Remove value, $Res Function(FeedOp_Remove) _then) = _$FeedOp_RemoveCopyWithImpl;
@useResult
$Res call({
 String key
});




}
/// @nodoc
class _$FeedOp_RemoveCopyWithImpl<$Res>
    implements $FeedOp_RemoveCopyWith<$Res> {
  _$FeedOp_RemoveCopyWithImpl(this._self, this._then);

  final FeedOp_Remove _self;
  final $Res Function(FeedOp_Remove) _then;

/// Create a copy of FeedOp
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? key = null,}) {
  return _then(FeedOp_Remove(
key: null == key ? _self.key : key // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc
mixin _$FeedRow {





@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is FeedRow);
}


@override
int get hashCode => runtimeType.hashCode;

@override
String toString() {
  return 'FeedRow()';
}


}

/// @nodoc
class $FeedRowCopyWith<$Res>  {
$FeedRowCopyWith(FeedRow _, $Res Function(FeedRow) __);
}


/// Adds pattern-matching-related methods to [FeedRow].
extension FeedRowPatterns on FeedRow {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>({TResult Function( FeedRow_Message value)?  message,TResult Function( FeedRow_Run value)?  run,TResult Function( FeedRow_Steps value)?  steps,TResult Function( FeedRow_Timer value)?  timer,TResult Function( FeedRow_TurnFooter value)?  turnFooter,TResult Function( FeedRow_ResponseActions value)?  responseActions,required TResult orElse(),}){
final _that = this;
switch (_that) {
case FeedRow_Message() when message != null:
return message(_that);case FeedRow_Run() when run != null:
return run(_that);case FeedRow_Steps() when steps != null:
return steps(_that);case FeedRow_Timer() when timer != null:
return timer(_that);case FeedRow_TurnFooter() when turnFooter != null:
return turnFooter(_that);case FeedRow_ResponseActions() when responseActions != null:
return responseActions(_that);case _:
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

@optionalTypeArgs TResult map<TResult extends Object?>({required TResult Function( FeedRow_Message value)  message,required TResult Function( FeedRow_Run value)  run,required TResult Function( FeedRow_Steps value)  steps,required TResult Function( FeedRow_Timer value)  timer,required TResult Function( FeedRow_TurnFooter value)  turnFooter,required TResult Function( FeedRow_ResponseActions value)  responseActions,}){
final _that = this;
switch (_that) {
case FeedRow_Message():
return message(_that);case FeedRow_Run():
return run(_that);case FeedRow_Steps():
return steps(_that);case FeedRow_Timer():
return timer(_that);case FeedRow_TurnFooter():
return turnFooter(_that);case FeedRow_ResponseActions():
return responseActions(_that);}
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>({TResult? Function( FeedRow_Message value)?  message,TResult? Function( FeedRow_Run value)?  run,TResult? Function( FeedRow_Steps value)?  steps,TResult? Function( FeedRow_Timer value)?  timer,TResult? Function( FeedRow_TurnFooter value)?  turnFooter,TResult? Function( FeedRow_ResponseActions value)?  responseActions,}){
final _that = this;
switch (_that) {
case FeedRow_Message() when message != null:
return message(_that);case FeedRow_Run() when run != null:
return run(_that);case FeedRow_Steps() when steps != null:
return steps(_that);case FeedRow_Timer() when timer != null:
return timer(_that);case FeedRow_TurnFooter() when turnFooter != null:
return turnFooter(_that);case FeedRow_ResponseActions() when responseActions != null:
return responseActions(_that);case _:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>({TResult Function( int uid,  ResultsRef? results,  bool streamingSpinner,  bool parts)?  message,TResult Function( String runKey,  List<StepRef> steps,  int shownFrom,  bool expanded,  ResultsRef results,  String? anchorMessageId)?  run,TResult Function( String turnKey,  List<StepCountView> counts,  bool expanded,  TimerView? timer)?  steps,TResult Function( String? turnKey,  TimerView? timer)?  timer,TResult Function( String turnKey)?  turnFooter,TResult Function( int uid,  String turnKey,  String atMessageId)?  responseActions,required TResult orElse(),}) {final _that = this;
switch (_that) {
case FeedRow_Message() when message != null:
return message(_that.uid,_that.results,_that.streamingSpinner,_that.parts);case FeedRow_Run() when run != null:
return run(_that.runKey,_that.steps,_that.shownFrom,_that.expanded,_that.results,_that.anchorMessageId);case FeedRow_Steps() when steps != null:
return steps(_that.turnKey,_that.counts,_that.expanded,_that.timer);case FeedRow_Timer() when timer != null:
return timer(_that.turnKey,_that.timer);case FeedRow_TurnFooter() when turnFooter != null:
return turnFooter(_that.turnKey);case FeedRow_ResponseActions() when responseActions != null:
return responseActions(_that.uid,_that.turnKey,_that.atMessageId);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>({required TResult Function( int uid,  ResultsRef? results,  bool streamingSpinner,  bool parts)  message,required TResult Function( String runKey,  List<StepRef> steps,  int shownFrom,  bool expanded,  ResultsRef results,  String? anchorMessageId)  run,required TResult Function( String turnKey,  List<StepCountView> counts,  bool expanded,  TimerView? timer)  steps,required TResult Function( String? turnKey,  TimerView? timer)  timer,required TResult Function( String turnKey)  turnFooter,required TResult Function( int uid,  String turnKey,  String atMessageId)  responseActions,}) {final _that = this;
switch (_that) {
case FeedRow_Message():
return message(_that.uid,_that.results,_that.streamingSpinner,_that.parts);case FeedRow_Run():
return run(_that.runKey,_that.steps,_that.shownFrom,_that.expanded,_that.results,_that.anchorMessageId);case FeedRow_Steps():
return steps(_that.turnKey,_that.counts,_that.expanded,_that.timer);case FeedRow_Timer():
return timer(_that.turnKey,_that.timer);case FeedRow_TurnFooter():
return turnFooter(_that.turnKey);case FeedRow_ResponseActions():
return responseActions(_that.uid,_that.turnKey,_that.atMessageId);}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>({TResult? Function( int uid,  ResultsRef? results,  bool streamingSpinner,  bool parts)?  message,TResult? Function( String runKey,  List<StepRef> steps,  int shownFrom,  bool expanded,  ResultsRef results,  String? anchorMessageId)?  run,TResult? Function( String turnKey,  List<StepCountView> counts,  bool expanded,  TimerView? timer)?  steps,TResult? Function( String? turnKey,  TimerView? timer)?  timer,TResult? Function( String turnKey)?  turnFooter,TResult? Function( int uid,  String turnKey,  String atMessageId)?  responseActions,}) {final _that = this;
switch (_that) {
case FeedRow_Message() when message != null:
return message(_that.uid,_that.results,_that.streamingSpinner,_that.parts);case FeedRow_Run() when run != null:
return run(_that.runKey,_that.steps,_that.shownFrom,_that.expanded,_that.results,_that.anchorMessageId);case FeedRow_Steps() when steps != null:
return steps(_that.turnKey,_that.counts,_that.expanded,_that.timer);case FeedRow_Timer() when timer != null:
return timer(_that.turnKey,_that.timer);case FeedRow_TurnFooter() when turnFooter != null:
return turnFooter(_that.turnKey);case FeedRow_ResponseActions() when responseActions != null:
return responseActions(_that.uid,_that.turnKey,_that.atMessageId);case _:
  return null;

}
}

}

/// @nodoc


class FeedRow_Message extends FeedRow {
  const FeedRow_Message({required this.uid, this.results, required this.streamingSpinner, required this.parts}): super._();
  

 final  int uid;
 final  ResultsRef? results;
 final  bool streamingSpinner;
 final  bool parts;

/// Create a copy of FeedRow
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$FeedRow_MessageCopyWith<FeedRow_Message> get copyWith => _$FeedRow_MessageCopyWithImpl<FeedRow_Message>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is FeedRow_Message&&(identical(other.uid, uid) || other.uid == uid)&&(identical(other.results, results) || other.results == results)&&(identical(other.streamingSpinner, streamingSpinner) || other.streamingSpinner == streamingSpinner)&&(identical(other.parts, parts) || other.parts == parts));
}


@override
int get hashCode => Object.hash(runtimeType,uid,results,streamingSpinner,parts);

@override
String toString() {
  return 'FeedRow.message(uid: $uid, results: $results, streamingSpinner: $streamingSpinner, parts: $parts)';
}


}

/// @nodoc
abstract mixin class $FeedRow_MessageCopyWith<$Res> implements $FeedRowCopyWith<$Res> {
  factory $FeedRow_MessageCopyWith(FeedRow_Message value, $Res Function(FeedRow_Message) _then) = _$FeedRow_MessageCopyWithImpl;
@useResult
$Res call({
 int uid, ResultsRef? results, bool streamingSpinner, bool parts
});




}
/// @nodoc
class _$FeedRow_MessageCopyWithImpl<$Res>
    implements $FeedRow_MessageCopyWith<$Res> {
  _$FeedRow_MessageCopyWithImpl(this._self, this._then);

  final FeedRow_Message _self;
  final $Res Function(FeedRow_Message) _then;

/// Create a copy of FeedRow
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? uid = null,Object? results = freezed,Object? streamingSpinner = null,Object? parts = null,}) {
  return _then(FeedRow_Message(
uid: null == uid ? _self.uid : uid // ignore: cast_nullable_to_non_nullable
as int,results: freezed == results ? _self.results : results // ignore: cast_nullable_to_non_nullable
as ResultsRef?,streamingSpinner: null == streamingSpinner ? _self.streamingSpinner : streamingSpinner // ignore: cast_nullable_to_non_nullable
as bool,parts: null == parts ? _self.parts : parts // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

/// @nodoc


class FeedRow_Run extends FeedRow {
  const FeedRow_Run({required this.runKey, required final  List<StepRef> steps, required this.shownFrom, required this.expanded, required this.results, this.anchorMessageId}): _steps = steps,super._();
  

 final  String runKey;
 final  List<StepRef> _steps;
 List<StepRef> get steps {
  if (_steps is EqualUnmodifiableListView) return _steps;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_steps);
}

 final  int shownFrom;
 final  bool expanded;
 final  ResultsRef results;
 final  String? anchorMessageId;

/// Create a copy of FeedRow
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$FeedRow_RunCopyWith<FeedRow_Run> get copyWith => _$FeedRow_RunCopyWithImpl<FeedRow_Run>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is FeedRow_Run&&(identical(other.runKey, runKey) || other.runKey == runKey)&&const DeepCollectionEquality().equals(other._steps, _steps)&&(identical(other.shownFrom, shownFrom) || other.shownFrom == shownFrom)&&(identical(other.expanded, expanded) || other.expanded == expanded)&&(identical(other.results, results) || other.results == results)&&(identical(other.anchorMessageId, anchorMessageId) || other.anchorMessageId == anchorMessageId));
}


@override
int get hashCode => Object.hash(runtimeType,runKey,const DeepCollectionEquality().hash(_steps),shownFrom,expanded,results,anchorMessageId);

@override
String toString() {
  return 'FeedRow.run(runKey: $runKey, steps: $steps, shownFrom: $shownFrom, expanded: $expanded, results: $results, anchorMessageId: $anchorMessageId)';
}


}

/// @nodoc
abstract mixin class $FeedRow_RunCopyWith<$Res> implements $FeedRowCopyWith<$Res> {
  factory $FeedRow_RunCopyWith(FeedRow_Run value, $Res Function(FeedRow_Run) _then) = _$FeedRow_RunCopyWithImpl;
@useResult
$Res call({
 String runKey, List<StepRef> steps, int shownFrom, bool expanded, ResultsRef results, String? anchorMessageId
});




}
/// @nodoc
class _$FeedRow_RunCopyWithImpl<$Res>
    implements $FeedRow_RunCopyWith<$Res> {
  _$FeedRow_RunCopyWithImpl(this._self, this._then);

  final FeedRow_Run _self;
  final $Res Function(FeedRow_Run) _then;

/// Create a copy of FeedRow
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? runKey = null,Object? steps = null,Object? shownFrom = null,Object? expanded = null,Object? results = null,Object? anchorMessageId = freezed,}) {
  return _then(FeedRow_Run(
runKey: null == runKey ? _self.runKey : runKey // ignore: cast_nullable_to_non_nullable
as String,steps: null == steps ? _self._steps : steps // ignore: cast_nullable_to_non_nullable
as List<StepRef>,shownFrom: null == shownFrom ? _self.shownFrom : shownFrom // ignore: cast_nullable_to_non_nullable
as int,expanded: null == expanded ? _self.expanded : expanded // ignore: cast_nullable_to_non_nullable
as bool,results: null == results ? _self.results : results // ignore: cast_nullable_to_non_nullable
as ResultsRef,anchorMessageId: freezed == anchorMessageId ? _self.anchorMessageId : anchorMessageId // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}

/// @nodoc


class FeedRow_Steps extends FeedRow {
  const FeedRow_Steps({required this.turnKey, required final  List<StepCountView> counts, required this.expanded, this.timer}): _counts = counts,super._();
  

 final  String turnKey;
 final  List<StepCountView> _counts;
 List<StepCountView> get counts {
  if (_counts is EqualUnmodifiableListView) return _counts;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_counts);
}

 final  bool expanded;
 final  TimerView? timer;

/// Create a copy of FeedRow
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$FeedRow_StepsCopyWith<FeedRow_Steps> get copyWith => _$FeedRow_StepsCopyWithImpl<FeedRow_Steps>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is FeedRow_Steps&&(identical(other.turnKey, turnKey) || other.turnKey == turnKey)&&const DeepCollectionEquality().equals(other._counts, _counts)&&(identical(other.expanded, expanded) || other.expanded == expanded)&&(identical(other.timer, timer) || other.timer == timer));
}


@override
int get hashCode => Object.hash(runtimeType,turnKey,const DeepCollectionEquality().hash(_counts),expanded,timer);

@override
String toString() {
  return 'FeedRow.steps(turnKey: $turnKey, counts: $counts, expanded: $expanded, timer: $timer)';
}


}

/// @nodoc
abstract mixin class $FeedRow_StepsCopyWith<$Res> implements $FeedRowCopyWith<$Res> {
  factory $FeedRow_StepsCopyWith(FeedRow_Steps value, $Res Function(FeedRow_Steps) _then) = _$FeedRow_StepsCopyWithImpl;
@useResult
$Res call({
 String turnKey, List<StepCountView> counts, bool expanded, TimerView? timer
});




}
/// @nodoc
class _$FeedRow_StepsCopyWithImpl<$Res>
    implements $FeedRow_StepsCopyWith<$Res> {
  _$FeedRow_StepsCopyWithImpl(this._self, this._then);

  final FeedRow_Steps _self;
  final $Res Function(FeedRow_Steps) _then;

/// Create a copy of FeedRow
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? turnKey = null,Object? counts = null,Object? expanded = null,Object? timer = freezed,}) {
  return _then(FeedRow_Steps(
turnKey: null == turnKey ? _self.turnKey : turnKey // ignore: cast_nullable_to_non_nullable
as String,counts: null == counts ? _self._counts : counts // ignore: cast_nullable_to_non_nullable
as List<StepCountView>,expanded: null == expanded ? _self.expanded : expanded // ignore: cast_nullable_to_non_nullable
as bool,timer: freezed == timer ? _self.timer : timer // ignore: cast_nullable_to_non_nullable
as TimerView?,
  ));
}


}

/// @nodoc


class FeedRow_Timer extends FeedRow {
  const FeedRow_Timer({this.turnKey, this.timer}): super._();
  

 final  String? turnKey;
 final  TimerView? timer;

/// Create a copy of FeedRow
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$FeedRow_TimerCopyWith<FeedRow_Timer> get copyWith => _$FeedRow_TimerCopyWithImpl<FeedRow_Timer>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is FeedRow_Timer&&(identical(other.turnKey, turnKey) || other.turnKey == turnKey)&&(identical(other.timer, timer) || other.timer == timer));
}


@override
int get hashCode => Object.hash(runtimeType,turnKey,timer);

@override
String toString() {
  return 'FeedRow.timer(turnKey: $turnKey, timer: $timer)';
}


}

/// @nodoc
abstract mixin class $FeedRow_TimerCopyWith<$Res> implements $FeedRowCopyWith<$Res> {
  factory $FeedRow_TimerCopyWith(FeedRow_Timer value, $Res Function(FeedRow_Timer) _then) = _$FeedRow_TimerCopyWithImpl;
@useResult
$Res call({
 String? turnKey, TimerView? timer
});




}
/// @nodoc
class _$FeedRow_TimerCopyWithImpl<$Res>
    implements $FeedRow_TimerCopyWith<$Res> {
  _$FeedRow_TimerCopyWithImpl(this._self, this._then);

  final FeedRow_Timer _self;
  final $Res Function(FeedRow_Timer) _then;

/// Create a copy of FeedRow
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? turnKey = freezed,Object? timer = freezed,}) {
  return _then(FeedRow_Timer(
turnKey: freezed == turnKey ? _self.turnKey : turnKey // ignore: cast_nullable_to_non_nullable
as String?,timer: freezed == timer ? _self.timer : timer // ignore: cast_nullable_to_non_nullable
as TimerView?,
  ));
}


}

/// @nodoc


class FeedRow_TurnFooter extends FeedRow {
  const FeedRow_TurnFooter({required this.turnKey}): super._();
  

 final  String turnKey;

/// Create a copy of FeedRow
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$FeedRow_TurnFooterCopyWith<FeedRow_TurnFooter> get copyWith => _$FeedRow_TurnFooterCopyWithImpl<FeedRow_TurnFooter>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is FeedRow_TurnFooter&&(identical(other.turnKey, turnKey) || other.turnKey == turnKey));
}


@override
int get hashCode => Object.hash(runtimeType,turnKey);

@override
String toString() {
  return 'FeedRow.turnFooter(turnKey: $turnKey)';
}


}

/// @nodoc
abstract mixin class $FeedRow_TurnFooterCopyWith<$Res> implements $FeedRowCopyWith<$Res> {
  factory $FeedRow_TurnFooterCopyWith(FeedRow_TurnFooter value, $Res Function(FeedRow_TurnFooter) _then) = _$FeedRow_TurnFooterCopyWithImpl;
@useResult
$Res call({
 String turnKey
});




}
/// @nodoc
class _$FeedRow_TurnFooterCopyWithImpl<$Res>
    implements $FeedRow_TurnFooterCopyWith<$Res> {
  _$FeedRow_TurnFooterCopyWithImpl(this._self, this._then);

  final FeedRow_TurnFooter _self;
  final $Res Function(FeedRow_TurnFooter) _then;

/// Create a copy of FeedRow
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? turnKey = null,}) {
  return _then(FeedRow_TurnFooter(
turnKey: null == turnKey ? _self.turnKey : turnKey // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

/// @nodoc


class FeedRow_ResponseActions extends FeedRow {
  const FeedRow_ResponseActions({required this.uid, required this.turnKey, required this.atMessageId}): super._();
  

 final  int uid;
 final  String turnKey;
 final  String atMessageId;

/// Create a copy of FeedRow
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$FeedRow_ResponseActionsCopyWith<FeedRow_ResponseActions> get copyWith => _$FeedRow_ResponseActionsCopyWithImpl<FeedRow_ResponseActions>(this, _$identity);



@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is FeedRow_ResponseActions&&(identical(other.uid, uid) || other.uid == uid)&&(identical(other.turnKey, turnKey) || other.turnKey == turnKey)&&(identical(other.atMessageId, atMessageId) || other.atMessageId == atMessageId));
}


@override
int get hashCode => Object.hash(runtimeType,uid,turnKey,atMessageId);

@override
String toString() {
  return 'FeedRow.responseActions(uid: $uid, turnKey: $turnKey, atMessageId: $atMessageId)';
}


}

/// @nodoc
abstract mixin class $FeedRow_ResponseActionsCopyWith<$Res> implements $FeedRowCopyWith<$Res> {
  factory $FeedRow_ResponseActionsCopyWith(FeedRow_ResponseActions value, $Res Function(FeedRow_ResponseActions) _then) = _$FeedRow_ResponseActionsCopyWithImpl;
@useResult
$Res call({
 int uid, String turnKey, String atMessageId
});




}
/// @nodoc
class _$FeedRow_ResponseActionsCopyWithImpl<$Res>
    implements $FeedRow_ResponseActionsCopyWith<$Res> {
  _$FeedRow_ResponseActionsCopyWithImpl(this._self, this._then);

  final FeedRow_ResponseActions _self;
  final $Res Function(FeedRow_ResponseActions) _then;

/// Create a copy of FeedRow
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') $Res call({Object? uid = null,Object? turnKey = null,Object? atMessageId = null,}) {
  return _then(FeedRow_ResponseActions(
uid: null == uid ? _self.uid : uid // ignore: cast_nullable_to_non_nullable
as int,turnKey: null == turnKey ? _self.turnKey : turnKey // ignore: cast_nullable_to_non_nullable
as String,atMessageId: null == atMessageId ? _self.atMessageId : atMessageId // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

// dart format on
