/// Chat attachment limits and the ready upload a message carries as
/// `cloudAttachments[]`. Computer chat transports share them: both
/// upload to the same attachment store and send the same reference.
library;

import 'package:mobile/data/models/chat_message.dart';

/// Mirrors `packages/protocol/src/cloud-attachments/index.ts`. Keep in sync.
const int kChatAttachmentMaxBytes = 10 * 1024 * 1024;
const int kChatAttachmentsMaxPerMessage = 8;
const int kChatAttachmentFilenameMaxBytes = 255;
const String kChatAttachmentDocxMediaType =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const String kChatAttachmentXlsxMediaType =
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const Set<String> kChatAttachmentMediaTypes = {
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  kChatAttachmentDocxMediaType,
  kChatAttachmentXlsxMediaType,
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'application/json',
};

const Map<String, String> _mediaTypeByExtension = {
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'pdf': 'application/pdf',
  'docx': kChatAttachmentDocxMediaType,
  'xlsx': kChatAttachmentXlsxMediaType,
  'txt': 'text/plain',
  'md': 'text/markdown',
  'markdown': 'text/markdown',
  'csv': 'text/csv',
  'html': 'text/html',
  'htm': 'text/html',
  'json': 'application/json',
};

/// Allowlisted media type for [filename]'s extension, or null when the file
/// cannot be attached (mirrors `mediaTypeForAttachmentFilename`).
String? chatAttachmentMediaTypeForFilename(String filename) {
  final dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot == filename.length - 1) return null;
  return _mediaTypeByExtension[filename.substring(dot + 1).toLowerCase()];
}

/// Ready upload the composer sends as `cloudAttachments[]`
/// (`RemoteControlChatCloudAttachmentRef`). JSON keys match the wire protocol.
class ChatAttachmentRef {
  const ChatAttachmentRef({
    required this.attachmentId,
    required this.filename,
    required this.mediaType,
    required this.size,
    required this.contentSha256,
    required this.storageKind,
    required this.source,
  });

  final String attachmentId;
  final String filename;
  final String mediaType;
  final int size;
  final String contentSha256;
  final String storageKind;
  final String source;

  factory ChatAttachmentRef.fromJson(Map<String, dynamic> json) {
    final size = json['size'];
    return ChatAttachmentRef(
      attachmentId: _stringValue(json['attachmentId']),
      filename: _stringValue(json['filename']),
      mediaType: _stringValue(json['mediaType']),
      size: size is num ? size.toInt() : 0,
      contentSha256: _stringValue(json['contentSha256']),
      storageKind: _stringValue(json['storageKind'], fallback: 'blob'),
      source: _stringValue(json['source']),
    );
  }

  Map<String, dynamic> toJson() => {
    'attachmentId': attachmentId,
    'filename': filename,
    'mediaType': mediaType,
    'size': size,
    'contentSha256': contentSha256,
    'storageKind': storageKind,
    'source': source,
  };

  ChatMessageAttachment toMessageAttachment() => ChatMessageAttachment(
    attachmentId: attachmentId,
    filename: filename,
    mediaType: mediaType,
    size: size,
  );
}

String _stringValue(Object? value, {String fallback = ''}) =>
    value is String ? value : fallback;
