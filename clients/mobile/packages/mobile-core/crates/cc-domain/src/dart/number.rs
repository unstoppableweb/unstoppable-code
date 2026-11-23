//! Dart's number printing: `double.toString()` and `'$n'` for a `num`.

/// Dart's `double.toString()` (the JavaScript number format, with `.0` on
/// integral values).
pub fn double_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if value == 0.0 {
        return if value.is_sign_negative() {
            "-0.0"
        } else {
            "0.0"
        }
        .into();
    }
    // Shortest round-trip digits and the decimal exponent.
    let formatted = format!("{:e}", value.abs());
    let (mantissa, exponent) = formatted.split_once('e').unwrap_or((&formatted, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let exponent: i64 = exponent.parse().unwrap_or(0);
    let sign = if value < 0.0 { "-" } else { "" };
    let k = i64::try_from(digits.len()).unwrap_or(1);
    let n = exponent + 1;
    let body = if k <= n && n <= 21 {
        format!(
            "{digits}{}.0",
            "0".repeat(usize::try_from(n - k).unwrap_or(0))
        )
    } else if 0 < n && n <= 21 {
        let (int, frac) = digits.split_at(usize::try_from(n).unwrap_or(0));
        format!("{int}.{frac}")
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat(usize::try_from(-n).unwrap_or(0)))
    } else {
        let (first, rest) = digits.split_at(1);
        let rest = if rest.is_empty() {
            String::new()
        } else {
            format!(".{rest}")
        };
        let e = n - 1;
        format!("{first}{rest}e{}{}", if e < 0 { "-" } else { "+" }, e.abs())
    };
    format!("{sign}{body}")
}

/// A num as `'$n'` prints it: an `int` plainly, a `double` per Dart.
pub fn num_to_string(value: f64, integer: bool) -> String {
    if integer && value.fract() == 0.0 && value.abs() < 9.007_199_254_740_992e15 {
        // Exact: an integer below 2^53.
        #[allow(clippy::cast_possible_truncation)]
        return (value as i64).to_string();
    }
    double_to_string(value)
}
