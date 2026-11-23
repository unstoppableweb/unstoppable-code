//! Dart `DateTime` behavior (UTC only): `DateTime.tryParse`,
//! `fromMillisecondsSinceEpoch`, `toIso8601String` and `toString`.

/// Microseconds since the epoch, the precision of a Dart `DateTime`.
pub type Micros = i64;

/// `DateTime` accepts at most 8.64e15 ms either side of the epoch.
const MAX_MS: i64 = 8_640_000_000_000_000;

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

struct Parts {
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
    milli: i64,
    micro: i64,
}

fn parts(us: Micros) -> Parts {
    let days = us.div_euclid(86_400_000_000);
    let rest = us.rem_euclid(86_400_000_000);
    let (year, month, day) = civil_from_days(days);
    Parts {
        year,
        month,
        day,
        hour: rest / 3_600_000_000,
        minute: rest / 60_000_000 % 60,
        second: rest / 1_000_000 % 60,
        milli: rest / 1000 % 1000,
        micro: rest % 1000,
    }
}

fn four_digits(n: i64) -> String {
    let sign = if n < 0 { "-" } else { "" };
    format!("{sign}{:04}", n.abs())
}

fn six_digits(n: i64) -> String {
    let sign = if n < 0 { "-" } else { "+" };
    format!("{sign}{:06}", n.abs())
}

fn clock(p: &Parts) -> String {
    let micro = if p.micro == 0 {
        String::new()
    } else {
        format!("{:03}", p.micro)
    };
    format!(
        "{:02}:{:02}:{:02}.{:03}{micro}Z",
        p.hour, p.minute, p.second, p.milli
    )
}

/// `DateTime.toUtc().toIso8601String()`.
pub fn iso8601(us: Micros) -> String {
    let p = parts(us);
    let year = if (-9999..=9999).contains(&p.year) {
        four_digits(p.year)
    } else {
        six_digits(p.year)
    };
    format!("{year}-{:02}-{:02}T{}", p.month, p.day, clock(&p))
}

/// `'$date'` for a UTC `DateTime` from milliseconds.
pub fn date_to_string(ms: i64) -> String {
    let p = parts(ms.saturating_mul(1000));
    format!(
        "{}-{:02}-{:02} {}",
        four_digits(p.year),
        p.month,
        p.day,
        clock(&p)
    )
}

/// `DateTime.fromMillisecondsSinceEpoch(ms.toInt(), isUtc: true)`; `None`
/// where Dart throws a `RangeError`.
pub fn from_millis(ms: f64) -> Option<Micros> {
    let ms = ms.trunc();
    // Exact: the bound is below 2^53.
    #[allow(clippy::cast_precision_loss)]
    let max = MAX_MS as f64;
    if !ms.is_finite() || ms.abs() > max {
        return None;
    }
    #[allow(clippy::cast_possible_truncation)]
    Some(ms as i64 * 1000)
}

fn take_digits(s: &[u8], at: &mut usize, min: usize, max: usize) -> Option<i64> {
    let start = *at;
    while *at < s.len() && *at - start < max && s[*at].is_ascii_digit() {
        *at += 1;
    }
    if *at - start < min {
        return None;
    }
    std::str::from_utf8(&s[start..*at]).ok()?.parse().ok()
}

/// `DateTime.tryParse(text)` as microseconds since the epoch, UTC.
///
/// Dart reads a string without a zone as local time; this reads it as UTC
/// (the core has no time zone database). Desktop timestamps carry `Z`.
pub fn parse_datetime(text: &str) -> Option<Micros> {
    let s = text.as_bytes();
    let (sign, start) = match s.first() {
        Some(b'+') => (1, 1),
        Some(b'-') => (-1, 1),
        _ => (1, 0),
    };
    // `[+-]?\d{4,6}` backtracks: try the longest year first.
    (4..=6)
        .rev()
        .filter(|len| {
            s.len() >= start + len && s[start..start + len].iter().all(u8::is_ascii_digit)
        })
        .find_map(|len| {
            let year: i64 = std::str::from_utf8(&s[start..start + len])
                .ok()?
                .parse()
                .ok()?;
            parse_after_year(s, start + len, sign * year)
        })
}

fn parse_after_year(s: &[u8], mut at: usize, year: i64) -> Option<Micros> {
    let skip = |at: &mut usize, byte: u8| {
        if s.get(*at) == Some(&byte) {
            *at += 1;
        }
    };
    // An optional separator, kept only when digits follow it.
    let separated_digits = |at: &mut usize, separator: u8| {
        let mut after = *at;
        skip(&mut after, separator);
        if s.get(after).is_some_and(u8::is_ascii_digit) {
            *at = after;
            true
        } else {
            false
        }
    };
    skip(&mut at, b'-');
    let month = take_digits(s, &mut at, 2, 2)?;
    skip(&mut at, b'-');
    let day = take_digits(s, &mut at, 2, 2)?;
    let (mut hour, mut minute, mut second, mut fraction) = (0, 0, 0, 0);
    let mut offset_minutes = 0;
    if at < s.len() {
        if !matches!(s[at], b' ' | b'T') {
            return None;
        }
        at += 1;
        hour = take_digits(s, &mut at, 2, 2)?;
        if separated_digits(&mut at, b':') {
            minute = take_digits(s, &mut at, 2, 2)?;
            if separated_digits(&mut at, b':') {
                second = take_digits(s, &mut at, 2, 2)?;
                if matches!(s.get(at), Some(b'.' | b',')) {
                    at += 1;
                    let start = at;
                    while at < s.len() && s[at].is_ascii_digit() {
                        at += 1;
                    }
                    if at == start {
                        return None;
                    }
                    // The first six digits: milliseconds and microseconds.
                    for i in 0..6 {
                        fraction *= 10;
                        if start + i < at {
                            fraction += i64::from(s[start + i] - b'0');
                        }
                    }
                }
            }
        }
        if at < s.len() {
            skip(&mut at, b' ');
            match s.get(at) {
                Some(b'z' | b'Z') => at += 1,
                Some(&sign @ (b'+' | b'-')) => {
                    at += 1;
                    let hours = take_digits(s, &mut at, 2, 2)?;
                    let minutes = if separated_digits(&mut at, b':') {
                        take_digits(s, &mut at, 2, 2)?
                    } else {
                        0
                    };
                    let total = hours * 60 + minutes;
                    offset_minutes = if sign == b'-' { -total } else { total };
                }
                _ => return None,
            }
            if at != s.len() {
                return None;
            }
        }
    }
    minute -= offset_minutes;
    // DateTime normalizes out-of-range fields.
    let months = year * 12 + (month - 1);
    let days = days_from_civil(months.div_euclid(12), months.rem_euclid(12) + 1, 1) + day - 1;
    let seconds = ((days * 24 + hour) * 60 + minute) * 60 + second;
    let us = seconds.checked_mul(1_000_000)?.checked_add(fraction)?;
    (us.abs() <= MAX_MS * 1000).then_some(us)
}

/// `DateTime.tryParse(text)?.millisecondsSinceEpoch`, UTC as
/// [`parse_datetime`].
pub fn parse_millis(text: &str) -> Option<i64> {
    parse_datetime(text).map(|us| us.div_euclid(1000))
}
