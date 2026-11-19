/* Host-owned constrained delegation boundary. No model-supplied executable,
 * flags, absolute paths, patterns, or environment. Pin the root once, then
 * open each component relative to that handle without following links.
 * argv: root [file-byte-bound]. The host chooses the per-file bound for the
 * session (default 64 KiB, at most 32 MiB); listings stay within 64 KiB.
 * stdin: R<TAB>relative-path<LF> or L<TAB>relative-directory<LF>.
 * stdout: OK <byte-count><LF><bytes> or ERR<LF>. L returns F/D + name + NUL.
 * EOF closes the pinned root, including when the owning application exits.
 */
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

#define PATH_BOUND 4096
#define LIST_BOUND 65536
#define DEFAULT_FILE_BOUND 65536
#define MAX_FILE_BOUND 33554432

/* Largest file this session reads, compares, or writes. */
static size_t file_bound = DEFAULT_FILE_BOUND;

/* A decimal bound from the host: digits only, 1..MAX_FILE_BOUND. */
static bool parse_bound(const char *text, size_t *bound) {
  size_t value = 0, digits = 0;
  for (; text[digits]; ++digits) {
    if (digits >= 9 || text[digits] < '0' || text[digits] > '9') return false;
    value = value * 10 + (size_t)(text[digits] - '0');
  }
  if (!digits || !value || value > MAX_FILE_BOUND) return false;
  *bound = value; return true;
}

static bool private_name(const char *name) {
  char lower[PATH_BOUND]; size_t n = strlen(name);
  if (!n || n >= sizeof lower || !strcmp(name, ".") || !strcmp(name, "..")) return true;
  for (size_t i = 0; i <= n; ++i) lower[i] = (char)tolower((unsigned char)name[i]);
  const char *denied[] = {".git", ".codex", ".claude", ".ssh", ".aws", ".kube", ".config", ".canopy", ".npmrc", ".netrc", "auth.json", "credentials"};
  for (size_t i = 0; i < sizeof denied / sizeof denied[0]; ++i) if (!strcmp(lower, denied[i])) return true;
  for (size_t i = 0; i < n; ++i) if ((unsigned char)name[i] < 32 || strchr("\\:/", name[i])) return true;
  return !strncmp(lower, ".env", 4) || (n >= 4 && (!strcmp(lower+n-4, ".pem") || !strcmp(lower+n-4, ".key")));
}

static bool valid_path(const char *path, bool directory) {
  size_t n = strlen(path);
  if (!n) return directory;
  if (n >= PATH_BOUND || path[0] == '/' || path[n-1] == '/') return false;
  char part[PATH_BOUND]; size_t used = 0;
  for (size_t i = 0; i <= n; ++i) {
    if (path[i] == '/' || !path[i]) {
      part[used] = 0;
      if (private_name(part)) return false;
      used = 0;
    } else part[used++] = path[i];
  }
  return true;
}

#ifdef _WIN32
#include "file-broker-windows.h"
#else
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/types.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <errno.h>
typedef int broker_handle;
#define BAD_HANDLE (-1)
static void close_handle(broker_handle handle) { close(handle); }

static broker_handle open_relative(broker_handle root, const char *path, bool directory) {
  int current = dup(root);
  if (current < 0 || !path[0]) return current;
  char parts[PATH_BOUND]; strcpy(parts, path);
  char *cursor = NULL; char *part = strtok_r(parts, "/", &cursor);
  while (part) {
    char *next = strtok_r(NULL, "/", &cursor);
    int flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW | ((next || directory) ? O_DIRECTORY : O_NONBLOCK);
    int opened = openat(current, part, flags);
    close(current); if (opened < 0) return BAD_HANDLE;
    current = opened; part = next;
  }
  return current;
}

static broker_handle open_root(const char *path) {
  if (path[0] != '/' || strlen(path) >= PATH_BOUND) return BAD_HANDLE;
  int slash = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (slash < 0) return BAD_HANDLE;
  // The host supplies a canonical absolute root. Components still cannot be links.
  int root = open_relative(slash, path + 1, true); close(slash); return root;
}

/* Reads the whole regular file into a new buffer the caller frees. A file
 * that grows past its size while being read is refused. */
static bool read_bytes(broker_handle file, char **bytes, size_t *used) {
  struct stat stat;
  *bytes = NULL; *used = 0;
  if (fstat(file, &stat) || !S_ISREG(stat.st_mode) || stat.st_nlink != 1 || stat.st_size < 0 || (unsigned long long)stat.st_size > file_bound) return false;
  size_t size = (size_t)stat.st_size, capacity = size + 1;
  char *buffer = malloc(capacity);
  if (!buffer) return false;
  while (*used < capacity) {
    ssize_t n = read(file, buffer + *used, capacity - *used);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) { free(buffer); return false; }
    if (!n) break;
    *used += (size_t)n;
  }
  if (*used > size) { free(buffer); return false; }
  *bytes = buffer; return true;
}

static bool holds_expected(broker_handle file, const char *expected, long old_size) {
  char *previous = NULL; size_t used = 0;
  bool ok = read_bytes(file, &previous, &used) && used == (size_t)old_size && !memcmp(previous, expected, used);
  free(previous); return ok;
}

static bool list_bytes(broker_handle root, char *bytes, size_t *used) {
  int copied = dup(root); if (copied < 0) return false;
  DIR *directory = fdopendir(copied);
  if (!directory) { close(copied); return false; }
  rewinddir(directory); *used = 0; unsigned entries = 0; bool ok = true;
  struct dirent *entry;
  errno = 0;
  while ((entry = readdir(directory))) {
    if (++entries > 4096) { ok = false; break; }
    if (private_name(entry->d_name)) continue;
    struct stat stat;
    if (fstatat(root, entry->d_name, &stat, AT_SYMLINK_NOFOLLOW)) continue;
    bool is_directory = S_ISDIR(stat.st_mode);
    if (!is_directory && (!S_ISREG(stat.st_mode) || stat.st_nlink != 1 || stat.st_size < 0 || (unsigned long long)stat.st_size > file_bound)) continue;
    size_t size = strlen(entry->d_name) + 2;
    if (*used + size > LIST_BOUND) { ok = false; break; }
    bytes[(*used)++] = is_directory ? 'D' : 'F';
    memcpy(bytes + *used, entry->d_name, size - 1); *used += size - 1;
    errno = 0;
  }
  if (!entry && errno) ok = false;
  closedir(directory); return ok;
}
#endif

/* Writes are reachable only through the owning host's per-operation grants and
 * approval checks. Never follow links; compare exact content before mutation.
 * Advisory lock coordinates cooperating helpers, not arbitrary external writers.
 * Replacement bytes are synced to a same-directory temporary file and renamed,
 * so a failed or interrupted write leaves the prior destination bytes intact. */
static bool write_bytes(broker_handle root, const char *path, const char *expected, long old_size, const char *replacement, long new_size) {
#ifdef _WIN32
  return write_bytes_windows(root, path, expected, old_size, replacement, new_size);
#else
  static unsigned temporary_sequence = 0;
  char parent[PATH_BOUND]; strcpy(parent, path);
  char *slash = strrchr(parent, '/');
  const char *leaf = slash ? slash + 1 : path;
  if (slash) *slash = 0; else parent[0] = 0;
  int directory = open_relative(root, parent, true);
  if (directory < 0) return false;
  bool ok = false, target_valid = false;
  int file = -1;
  struct stat initial, current;
  if (old_size < 0) {
    errno = 0;
    target_valid = fstatat(directory, leaf, &current, AT_SYMLINK_NOFOLLOW) < 0 && errno == ENOENT;
  } else {
    file = openat(directory, leaf, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
    target_valid = file >= 0 && !flock(file, LOCK_EX | LOCK_NB) && !fstat(file, &initial) &&
      S_ISREG(initial.st_mode) && initial.st_nlink == 1 && holds_expected(file, expected, old_size) &&
      !fstatat(directory, leaf, &current, AT_SYMLINK_NOFOLLOW) &&
      current.st_dev == initial.st_dev && current.st_ino == initial.st_ino && current.st_nlink == 1;
  }
  if (target_valid && new_size < 0 && old_size >= 0) {
    if (unlinkat(directory, leaf, 0) == 0) {
      ok = fsync(directory) == 0;
    }
  } else if (target_valid && new_size >= 0) {
    char temporary[96];
    int length = snprintf(temporary, sizeof temporary, ".canopy-write-%ld-%u", (long)getpid(), ++temporary_sequence);
    int staged = length > 0 && (size_t)length < sizeof temporary
      ? openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600)
      : -1;
    if (staged >= 0) {
      size_t written = 0;
      while (written < (size_t)new_size) {
        ssize_t n = write(staged, replacement + written, (size_t)new_size - written);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) break;
        written += (size_t)n;
      }
      bool staged_ok = written == (size_t)new_size &&
        (old_size < 0 || !fchmod(staged, initial.st_mode & 0777)) && !fsync(staged);
      close(staged);
      if (staged_ok && old_size >= 0) {
        staged_ok = lseek(file, 0, SEEK_SET) == 0 && holds_expected(file, expected, old_size) &&
          !fstatat(directory, leaf, &current, AT_SYMLINK_NOFOLLOW) &&
          current.st_dev == initial.st_dev && current.st_ino == initial.st_ino && current.st_nlink == 1;
      } else if (staged_ok) {
        errno = 0;
        staged_ok = fstatat(directory, leaf, &current, AT_SYMLINK_NOFOLLOW) < 0 && errno == ENOENT;
      }
      if (staged_ok && old_size < 0) {
        /* linkat installs a create without replacement: a concurrent creator
         * makes this fail with EEXIST instead of being overwritten by rename. */
        if (linkat(directory, temporary, directory, leaf, 0) == 0 &&
            unlinkat(directory, temporary, 0) == 0) {
          ok = fsync(directory) == 0;
        }
      } else if (staged_ok && renameat(directory, temporary, directory, leaf) == 0) {
        ok = fsync(directory) == 0;
      }
      if (!ok) unlinkat(directory, temporary, 0);
    }
  }
  if (file >= 0) close(file);
  close(directory); return ok;
#endif
}

static int serve(broker_handle root) {
  if (root == BAD_HANDLE) return 1;
  char line[PATH_BOUND + 64], listing[LIST_BOUND + 1];
  fputs("READY\n", stdout); fflush(stdout);
  unsigned requests = 0;
  while (fgets(line, sizeof line, stdin)) {
    if (++requests > 8192) break;
    size_t n = strlen(line);
    if (n < 3 || line[n-1] != '\n') break;
    line[n-1] = 0;
    if (line[0] == 'W' && line[1] == '\t') {
      char *old_text = strchr(line + 2, '\t');
      if (!old_text) break;
      *old_text++ = 0;
      char *new_text = strchr(old_text, '\t');
      if (!new_text) break;
      *new_text++ = 0;
      char *old_end, *new_end;
      long old_size = strtol(old_text, &old_end, 10), new_size = strtol(new_text, &new_end, 10);
      if (*old_end || *new_end || old_size < -1 || new_size < -1 ||
          (old_size > 0 && (size_t)old_size > file_bound) || (new_size > 0 && (size_t)new_size > file_bound)) break;
      size_t before = old_size < 0 ? 0 : (size_t)old_size, after = new_size < 0 ? 0 : (size_t)new_size;
      char *expected = malloc(before + 1), *replacement = malloc(after + 1);
      bool received = expected && replacement &&
        fread(expected, 1, before, stdin) == before && fread(replacement, 1, after, stdin) == after;
      bool ok = received && valid_path(line + 2, false) && !(old_size < 0 && new_size < 0) &&
        write_bytes(root, line + 2, expected, old_size, replacement, new_size);
      free(expected); free(replacement);
      if (!received) break;
      fputs(ok ? "OK 0\n" : "ERR\n", stdout); fflush(stdout); continue;
    }
    bool directory = line[0] == 'L';
    if ((line[0] != 'R' && !directory) || line[1] != '\t' || !valid_path(line + 2, directory)) {
      fputs("ERR\n", stdout); fflush(stdout); continue;
    }
    broker_handle file = open_relative(root, line + 2, directory);
    size_t used = 0;
    char *content = NULL;
    bool ok = file != BAD_HANDLE && (directory ? list_bytes(file, listing, &used) : read_bytes(file, &content, &used));
    if (file != BAD_HANDLE) close_handle(file);
    const char *output = directory ? listing : content;
    bool written = true;
    if (ok) { fprintf(stdout, "OK %zu\n", used); written = !used || fwrite(output, 1, used, stdout) == used; }
    else fputs("ERR\n", stdout);
    free(content);
    if (!written || fflush(stdout)) break;
  }
  close_handle(root); return 0;
}

#ifdef _WIN32
int wmain(int argc, wchar_t **argv) {
  if (argc != 2 && argc != 3) return 1;
  if (argc == 3) {
    char narrow[32];
    int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argv[2], -1, narrow, (int)sizeof narrow, NULL, NULL);
    if (n <= 0) return 1;
    if (!parse_bound(narrow, &file_bound)) return 1;
  }
  _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
  return serve(open_root(argv[1]));
}
#else
int main(int argc, char **argv) {
  if (argc != 2 && argc != 3) return 1;
  if (argc == 3) {
    if (!parse_bound(argv[2], &file_bound)) return 1;
  }
  return serve(open_root(argv[1]));
}
#endif
