import 'package:mobile/data/models/computer_activity/pipeline_dispatch.dart';

typedef PipelineFormRules = ({
  List<RemotePipelineInputDefinition> visible,
  Map<String, String> initial,
  Map<String, String> errors,
  Map<String, String> payload,
});
