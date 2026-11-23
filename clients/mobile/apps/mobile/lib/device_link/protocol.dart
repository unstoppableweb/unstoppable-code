class DeviceLinkException implements Exception {
  const DeviceLinkException(this.message);
  final String message;
  @override
  String toString() => message;
}

Map<String, dynamic> deviceLinkObject(Object? value) {
  if (value is! Map<String, dynamic>) {
    throw const DeviceLinkException('The peer sent an invalid message.');
  }
  return value;
}

String deviceLinkString(Map<String, dynamic> value, String key) {
  final field = value[key];
  if (field is! String || field.isEmpty || field.length > 4096) {
    throw const DeviceLinkException('The peer sent an invalid message.');
  }
  return field;
}
