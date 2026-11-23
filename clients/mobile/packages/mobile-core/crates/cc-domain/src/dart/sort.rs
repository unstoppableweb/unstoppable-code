//! `List.sort`: the Dart VM's `Sort` (`dart:_internal`, `sort.dart`), an
//! insertion sort up to 33 elements and a dual-pivot quicksort above. It is
//! not stable, so elements that compare equal end where Dart puts them only
//! when the same algorithm moves them (pipeline runs without a start time).
use std::cmp::Ordering;

const INSERTION_SORT_THRESHOLD: isize = 32;

/// Sorts `a` in place exactly as Dart's `a.sort(compare)` does.
pub fn sort<T: Clone>(a: &mut [T], compare: &impl Fn(&T, &T) -> Ordering) {
    if a.is_empty() {
        return;
    }
    let right = isize::try_from(a.len()).unwrap_or(isize::MAX) - 1;
    do_sort(a, 0, right, compare);
}

fn cmp<T>(compare: &impl Fn(&T, &T) -> Ordering, x: &T, y: &T) -> i32 {
    match compare(x, y) {
        Ordering::Less => -1,
        Ordering::Equal => 0,
        Ordering::Greater => 1,
    }
}

#[allow(clippy::cast_sign_loss)]
fn at(i: isize) -> usize {
    i as usize
}

fn do_sort<T: Clone>(a: &mut [T], left: isize, right: isize, c: &impl Fn(&T, &T) -> Ordering) {
    if right - left <= INSERTION_SORT_THRESHOLD {
        insertion_sort(a, left, right, c);
    } else {
        dual_pivot_quicksort(a, left, right, c);
    }
}

fn insertion_sort<T: Clone>(
    a: &mut [T],
    left: isize,
    right: isize,
    c: &impl Fn(&T, &T) -> Ordering,
) {
    let mut i = left + 1;
    while i <= right {
        let el = a[at(i)].clone();
        let mut j = i;
        while j > left && cmp(c, &a[at(j - 1)], &el) > 0 {
            a[at(j)] = a[at(j - 1)].clone();
            j -= 1;
        }
        a[at(j)] = el;
        i += 1;
    }
}

#[allow(clippy::too_many_lines)]
fn dual_pivot_quicksort<T: Clone>(
    a: &mut [T],
    left: isize,
    right: isize,
    c: &impl Fn(&T, &T) -> Ordering,
) {
    let sixth = (right - left + 1) / 6;
    let index1 = left + sixth;
    let index5 = right - sixth;
    let index3 = (left + right) / 2;
    let index2 = index3 - sixth;
    let index4 = index3 + sixth;

    let mut el1 = a[at(index1)].clone();
    let mut el2 = a[at(index2)].clone();
    let mut el3 = a[at(index3)].clone();
    let mut el4 = a[at(index4)].clone();
    let mut el5 = a[at(index5)].clone();

    if cmp(c, &el1, &el2) > 0 {
        std::mem::swap(&mut el1, &mut el2);
    }
    if cmp(c, &el4, &el5) > 0 {
        std::mem::swap(&mut el4, &mut el5);
    }
    if cmp(c, &el1, &el3) > 0 {
        std::mem::swap(&mut el1, &mut el3);
    }
    if cmp(c, &el2, &el3) > 0 {
        std::mem::swap(&mut el2, &mut el3);
    }
    if cmp(c, &el1, &el4) > 0 {
        std::mem::swap(&mut el1, &mut el4);
    }
    if cmp(c, &el3, &el4) > 0 {
        std::mem::swap(&mut el3, &mut el4);
    }
    if cmp(c, &el2, &el5) > 0 {
        std::mem::swap(&mut el2, &mut el5);
    }
    if cmp(c, &el2, &el3) > 0 {
        std::mem::swap(&mut el2, &mut el3);
    }
    if cmp(c, &el4, &el5) > 0 {
        std::mem::swap(&mut el4, &mut el5);
    }

    let pivot1 = el2;
    let pivot2 = el4;

    a[at(index1)] = el1;
    a[at(index3)] = el3;
    a[at(index5)] = el5;

    a[at(index2)] = a[at(left)].clone();
    a[at(index4)] = a[at(right)].clone();

    let mut less = left + 1;
    let mut great = right - 1;

    let pivots_are_equal = cmp(c, &pivot1, &pivot2) == 0;
    if pivots_are_equal {
        let pivot = pivot1.clone();
        let mut k = less;
        while k <= great {
            let ak = a[at(k)].clone();
            let comp = cmp(c, &ak, &pivot);
            if comp == 0 {
                k += 1;
                continue;
            }
            if comp < 0 {
                if k != less {
                    a[at(k)] = a[at(less)].clone();
                    a[at(less)] = ak;
                }
                less += 1;
            } else {
                loop {
                    let comp = cmp(c, &a[at(great)], &pivot);
                    if comp > 0 {
                        great -= 1;
                        continue;
                    } else if comp < 0 {
                        a[at(k)] = a[at(less)].clone();
                        a[at(less)] = a[at(great)].clone();
                        less += 1;
                        a[at(great)] = ak;
                        great -= 1;
                        break;
                    }
                    a[at(k)] = a[at(great)].clone();
                    a[at(great)] = ak;
                    great -= 1;
                    break;
                }
            }
            k += 1;
        }
    } else {
        let mut k = less;
        while k <= great {
            let ak = a[at(k)].clone();
            if cmp(c, &ak, &pivot1) < 0 {
                if k != less {
                    a[at(k)] = a[at(less)].clone();
                    a[at(less)] = ak;
                }
                less += 1;
            } else if cmp(c, &ak, &pivot2) > 0 {
                loop {
                    if cmp(c, &a[at(great)], &pivot2) > 0 {
                        great -= 1;
                        if great < k {
                            break;
                        }
                        continue;
                    }
                    if cmp(c, &a[at(great)], &pivot1) < 0 {
                        a[at(k)] = a[at(less)].clone();
                        a[at(less)] = a[at(great)].clone();
                        less += 1;
                        a[at(great)] = ak;
                        great -= 1;
                    } else {
                        a[at(k)] = a[at(great)].clone();
                        a[at(great)] = ak;
                        great -= 1;
                    }
                    break;
                }
            }
            k += 1;
        }
    }

    a[at(left)] = a[at(less - 1)].clone();
    a[at(less - 1)] = pivot1.clone();
    a[at(right)] = a[at(great + 1)].clone();
    a[at(great + 1)] = pivot2.clone();

    do_sort(a, left, less - 2, c);
    do_sort(a, great + 2, right, c);

    if pivots_are_equal {
        return;
    }

    if less < index1 && great > index5 {
        while cmp(c, &a[at(less)], &pivot1) == 0 {
            less += 1;
        }
        while cmp(c, &a[at(great)], &pivot2) == 0 {
            great -= 1;
        }
        let mut k = less;
        while k <= great {
            let ak = a[at(k)].clone();
            if cmp(c, &ak, &pivot1) == 0 {
                if k != less {
                    a[at(k)] = a[at(less)].clone();
                    a[at(less)] = ak;
                }
                less += 1;
            } else if cmp(c, &ak, &pivot2) == 0 {
                loop {
                    if cmp(c, &a[at(great)], &pivot2) == 0 {
                        great -= 1;
                        if great < k {
                            break;
                        }
                        continue;
                    }
                    if cmp(c, &a[at(great)], &pivot1) < 0 {
                        a[at(k)] = a[at(less)].clone();
                        a[at(less)] = a[at(great)].clone();
                        less += 1;
                        a[at(great)] = ak;
                        great -= 1;
                    } else {
                        a[at(k)] = a[at(great)].clone();
                        a[at(great)] = ak;
                        great -= 1;
                    }
                    break;
                }
            }
            k += 1;
        }
    }
    do_sort(a, less, great, c);
}
