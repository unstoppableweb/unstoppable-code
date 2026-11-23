/// Orders flattened Recents indexes by activity, with a per-computer limit.
typedef ComputerRecentOrder =
    List<int> Function({
      required List<List<int?>> computers,
      required int limit,
    });
