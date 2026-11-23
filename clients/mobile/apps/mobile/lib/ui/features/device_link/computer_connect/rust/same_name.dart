/// The member of [values] named like [value]: maps a core enum onto the app
/// enum it mirrors, and back, without a hand-written `switch` per pair
/// (architecture §3.1, "Thin Dart view models"). Throws [ArgumentError]
/// when the names differ; only pairs whose members are named alike use it.
T sameName<T extends Enum>(List<T> values, Enum value) =>
    values.byName(value.name);
