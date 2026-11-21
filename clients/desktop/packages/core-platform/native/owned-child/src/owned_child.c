// Owned daemon root for startup rollback (Darwin and Linux).
//
// The root is spawned with posix_spawn as a new session and process-group
// leader. Its exit is observed with waitid(WNOWAIT), which leaves it
// unreaped, so its PID, and with it the group ID, cannot be reused until this
// addon reaps it. Group signals are sent only through a validated, owned,
// unreaped handle. Errors carry fixed text: no paths, arguments, or input.
//
// A launcher-channel spawn (Darwin and Linux) also hands the child one end of a
// socketpair as fd 3. The parent end stays in the record and never reaches JS
// as a descriptor.
#if defined(__linux__)
// POSIX_SPAWN_SETSID and posix_spawn_file_actions_addclosefrom_np.
#define _GNU_SOURCE
#elif !defined(__APPLE__)
#error "core-owned-child supports Darwin and Linux only"
#endif

#include <node_api.h>

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#ifdef __APPLE__
#include <bsm/libbsm.h>
#include <libproc.h>
#include <mach/mach.h>
#include <sys/socket.h>
#include <sys/un.h>
#else
#include <dirent.h>
#include <pthread.h>
#include <sys/syscall.h>
#include <sys/stat.h>
#include <sys/vfs.h>
// UAPI constants may be newer than the build host headers. The kernel must
// implement these options and pidfs; channel setup refuses otherwise.
#ifndef SO_PASSPIDFD
#define SO_PASSPIDFD 76
#endif
#ifndef SCM_PIDFD
#define SCM_PIDFD 4
#endif
#ifndef PID_FS_MAGIC
#define PID_FS_MAGIC 0x50494446
#endif
#include <stdio.h>
#endif

#define MAX_STDIN_BYTES 4096
#define MAX_STRING_BYTES (64 * 1024)
#define MAX_VECTOR 4096
#define GROUP_CAPACITY 4096
#define DEADLINE_MS 2000
#define CHANNEL_FD 3
#define MAX_CHANNEL_BYTES (64 * 1024)

typedef enum { OWNED, COMMITTED } handle_state;

typedef struct record {
  uint64_t serial;
  pid_t pid;
  handle_state state;
  bool delivered;
  // Parent end of the launcher channel, or -1.
  int channel;
  // Darwin only: the root's spawn-time pidversion; an exec changes it.
  int pidversion;
#ifdef __linux__
  int pidfd;
  struct linux_image *image;
  bool image_taken;
  uid_t uid;
  gid_t gid;
  bool launcher_end;
  bool channel_eof;
#endif
  // Bytes read from the channel: peer evidence waits for the peer's frame.
  uint64_t received;
  struct record *next;
} record;

// One list per load: a handle from another load or env is unrelated.
typedef struct {
  record *head;
#ifdef __linux__
  bool linux_channel_ready;
#endif
} instance;

// Process-wide, so a serial never resolves in a load that did not issue it.
static uint64_t next_serial = 0;

// The wrapped JS object names its issuing load and serial; records live in
// that load's instance.
typedef struct {
  const instance *owner;
  uint64_t serial;
} token;

static const napi_type_tag HANDLE_TAG = {0x6f776e6564636869ULL,
                                         0x6c642d68616e646cULL};

typedef enum { ROOT_LOST, ROOT_RUNNING, ROOT_EXITED } root_state;
#ifdef __linux__
static bool linux_pidfs(int fd, struct stat *identity);
static void linux_image_close(record *item);
#endif

static void throw_code(napi_env env, const char *code, const char *message) {
  napi_throw_error(env, code, message);
}

static int64_t now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static void sleep_ms(long ms) {
  struct timespec t = {0, ms * 1000000L};
  while (nanosleep(&t, &t) == -1 && errno == EINTR) {
  }
}

// Leaves the root waitable. ROOT_LOST means it is no longer this process's
// unreaped child (reaped elsewhere), so its PID must never be signaled.
static root_state inspect_root(pid_t pid, siginfo_t *info) {
  siginfo_t local;
  siginfo_t *out = info ? info : &local;
  for (;;) {
    memset(out, 0, sizeof *out);
    if (waitid(P_PID, (id_t)pid, out, WEXITED | WNOWAIT | WNOHANG) == 0)
      return out->si_pid == pid ? ROOT_EXITED : ROOT_RUNNING;
    if (errno != EINTR) return ROOT_LOST;
  }
}

// Members of the root's group other than the root. -1 when the bounded
// enumeration fails or may be truncated. Callers hold the root unreaped, so a
// valid listing always contains the root: one without it (including an empty
// one) is a failure, never an empty group.
#ifdef __APPLE__
// Zombies included. proc_listpids returns bytes; proc_listpgrppids returns a
// PID count, so it is not used.
static int group_members(pid_t pid) {
  pid_t pids[GROUP_CAPACITY];
  errno = 0;
  int bytes =
      proc_listpids(PROC_PGRP_ONLY, (uint32_t)pid, pids, (int)sizeof pids);
  if (bytes <= 0 || bytes >= (int)sizeof pids || bytes % (int)sizeof(pid_t))
    return -1;
  int count = 0;
  bool root = false;
  for (int n = 0; n < bytes / (int)sizeof(pid_t); n++) {
    if (pids[n] == pid)
      root = true;
    else if (pids[n] > 0)
      count++;
  }
  return root ? count : -1;
}
#else
typedef enum { PROC_FAILED = -1, PROC_OTHER, PROC_EXITED, PROC_LIVE } proc_kind;

// Classifies /proc/<entry>/stat against `group`. PROC_OTHER covers another
// group and a process already gone; PROC_EXITED a zombie whose last thread is
// gone (a zombie leader still counts its live threads).
static proc_kind classify(const char *entry, pid_t group) {
  char file[64], text[512];
  if (snprintf(file, sizeof file, "/proc/%s/stat", entry) >= (int)sizeof file)
    return PROC_FAILED;
  int fd;
  do {
    fd = open(file, O_RDONLY | O_CLOEXEC);
  } while (fd < 0 && errno == EINTR);
  if (fd < 0) return errno == ENOENT || errno == ESRCH ? PROC_OTHER : PROC_FAILED;
  ssize_t size;
  do {
    size = read(fd, text, sizeof text - 1);
  } while (size < 0 && errno == EINTR);
  int failure = errno;
  close(fd);
  if (size < 0) return failure == ESRCH ? PROC_OTHER : PROC_FAILED;
  if (size == 0) return PROC_OTHER;
  text[size] = '\0';
  // The command name may contain ')' and spaces. After the last ')' come
  // state, ppid and pgrp; num_threads is the 18th field, after 14 skipped.
  const char *rest = strrchr(text, ')');
  char state;
  int parent, pgrp;
  long threads;
  if (!rest || sscanf(rest + 1,
                      " %c %d %d %*s %*s %*s %*s %*s %*s %*s %*s %*s %*s %*s "
                      "%*s %*s %*s %ld",
                      &state, &parent, &pgrp, &threads) != 4)
    return PROC_FAILED;
  if (pgrp != group) return PROC_OTHER;
  return (state == 'Z' || state == 'X') && threads <= 1 ? PROC_EXITED
                                                        : PROC_LIVE;
}

static bool numeric(const char *name) {
  if (!*name) return false;
  for (const char *at = name; *at; at++)
    if (*at < '0' || *at > '9') return false;
  return true;
}

// A bounded scan of /proc. Exited members are not counted: they hold nothing
// and cannot fork, and they may never be reaped (a container's PID 1, or a
// CLI running as PID 1, need not reap orphans). The scan is not a snapshot,
// so callers trust an empty result only after a group signal.
static int group_members(pid_t pid) {
  DIR *proc = opendir("/proc");
  if (!proc) return -1;
  int count = 0;
  bool root = false;
  bool failed = false;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(proc);
    if (!entry) {
      failed = errno != 0;
      break;
    }
    if (!numeric(entry->d_name)) continue;
    proc_kind kind = classify(entry->d_name, pid);
    if (kind == PROC_FAILED) {
      failed = true;
      break;
    }
    if (kind == PROC_OTHER) continue;
    if (strtol(entry->d_name, NULL, 10) == (long)pid)
      root = true;
    else if (kind == PROC_LIVE && ++count >= GROUP_CAPACITY - 1) {
      failed = true;
      break;
    }
  }
  closedir(proc);
  return failed || !root ? -1 : count;
}
#endif

// SIGKILL to the root's group. Darwin answers EPERM, not ESRCH, while a member
// is exiting or once only the exited root remains; Linux signals the zombie
// root and answers 0. Callers confirm the stop by enumeration and reaping, so
// a lasting EPERM runs into their deadline.
static bool signal_group(pid_t pid) {
  return kill(-pid, SIGKILL) == 0 || errno == ESRCH || errno == EPERM;
}

// Members left before an uncommitted exited root is reaped. Linux signals the
// group first: once it is signaled no member can fork, so the scan that
// follows misses none.
static int settled_members(pid_t pid) {
#ifdef __linux__
  if (!signal_group(pid)) return -1;
#endif
  return group_members(pid);
}

static bool reap(pid_t pid) {
  int status = 0;
  pid_t reaped;
  do {
    reaped = waitpid(pid, &status, WNOHANG);
  } while (reaped == -1 && errno == EINTR);
  return reaped == pid;
}

static void close_channel(record *item) {
#ifdef __linux__
  linux_image_close(item);
  if (item->pidfd >= 0) close(item->pidfd);
  item->pidfd = -1;
#endif
  if (item->channel < 0) return;
  close(item->channel);
  item->channel = -1;
}

static void free_record(record *item) {
  close_channel(item);
  free(item);
}

static void unlink_record(instance *inst, record *target) {
  for (record **at = &inst->head; *at; at = &(*at)->next)
    if (*at == target) {
      *at = target->next;
      free_record(target);
      return;
    }
}

// Synchronous rollback for paths that cannot wait on the event loop: host
// exit, env teardown, and a failed handle construction. Returns true once root and group are gone
// and the root is reaped.
static bool rollback_blocking(pid_t pid) {
  int64_t deadline = now_ms() + DEADLINE_MS;
  for (;;) {
    // The unreaped root reserves the group ID; never signal without it.
    root_state root = inspect_root(pid, NULL);
    if (root == ROOT_LOST) return false;
    if (root == ROOT_EXITED && settled_members(pid) == 0) return reap(pid);
    // Repeated: a member forked after the previous signal is caught next.
    if (!signal_group(pid)) return false;
    if (now_ms() >= deadline) return false;
    sleep_ms(10);
  }
}

static void report_teardown_failure(void) {
  static const char line[] = "Uncommitted child cleanup failed.\n";
  ssize_t ignored = write(STDERR_FILENO, line, sizeof line - 1);
  (void)ignored;
}

// Env teardown: an uncommitted handle is a startup that never committed, so
// its group is rolled back; committed daemons are left running.
static void env_cleanup(void *data) {
  instance *inst = data;
  record *item = inst->head;
  while (item) {
    record *next = item->next;
    if (item->state == OWNED && !rollback_blocking(item->pid))
      report_teardown_failure();
    free_record(item);
    item = next;
  }
  free(inst);
}

static void finalize_token(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  free(data);
}

// Resolves a handle issued by this load's spawn and not yet released. The
// instance arrives as callback data: env instance data is shared by every
// addon in the env, so it cannot identify this load.
static record *resolve_handle(napi_env env, instance *inst, napi_value value) {
  napi_valuetype type;
  bool tagged = false;
  void *data = NULL;
  if (inst && napi_typeof(env, value, &type) == napi_ok &&
      type == napi_object &&
      napi_check_object_type_tag(env, value, &HANDLE_TAG, &tagged) ==
          napi_ok &&
      tagged && napi_unwrap(env, value, &data) == napi_ok && data &&
      ((token *)data)->owner == inst) {
    uint64_t serial = ((token *)data)->serial;
    for (record *item = inst->head; item; item = item->next)
      if (item->serial == serial) return item;
  }
  throw_code(env, "ERR_OWNED_CHILD_HANDLE", "Owned child handle is invalid.");
  return NULL;
}

static record *handle_arg(napi_env env, napi_callback_info info,
                          instance **inst) {
  size_t argc = 1;
  napi_value argv[1];
  void *data = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok ||
      argc != 1 || !data) {
    throw_code(env, "ERR_OWNED_CHILD_ARGUMENT", "Owned child call is invalid.");
    return NULL;
  }
  *inst = data;
  return resolve_handle(env, *inst, argv[0]);
}

static napi_value make_int(napi_env env, int64_t value) {
  napi_value out;
  napi_create_int64(env, value, &out);
  return out;
}

static napi_value make_null(napi_env env) {
  napi_value out;
  napi_get_null(env, &out);
  return out;
}

static napi_value make_bool(napi_env env, bool value) {
  napi_value out;
  napi_get_boolean(env, value, &out);
  return out;
}

static napi_value make_state(napi_env env, const char *state) {
  napi_value out, text;
  napi_create_object(env, &out);
  napi_create_string_utf8(env, state, NAPI_AUTO_LENGTH, &text);
  napi_set_named_property(env, out, "state", text);
  return out;
}

// Copies a JS string without embedded NULs. Returns NULL with no exception
// pending; the caller throws one fixed error.
static char *copy_string(napi_env env, napi_value value) {
  napi_valuetype type;
  size_t size = 0;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, value, NULL, 0, &size) != napi_ok ||
      size > MAX_STRING_BYTES)
    return NULL;
  char *text = calloc(size + 1, 1);
  if (!text) return NULL;
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, text, size + 1, &copied) !=
          napi_ok ||
      copied != size || strlen(text) != size) {
    free(text);
    return NULL;
  }
  return text;
}

static void free_vector(char **items) {
  if (!items) return;
  for (char **at = items; *at; at++) free(*at);
  free(items);
}

static char **copy_vector(napi_env env, napi_value value, size_t minimum) {
  bool array = false;
  uint32_t length = 0;
  if (napi_is_array(env, value, &array) != napi_ok || !array ||
      napi_get_array_length(env, value, &length) != napi_ok ||
      length < minimum || length > MAX_VECTOR)
    return NULL;
  char **items = calloc((size_t)length + 1, sizeof *items);
  if (!items) return NULL;
  for (uint32_t n = 0; n < length; n++) {
    napi_value item;
    if (napi_get_element(env, value, n, &item) != napi_ok ||
        !(items[n] = copy_string(env, item))) {
      free_vector(items);
      return NULL;
    }
  }
  return items;
}

// channel_fd, when >= 0, is above fd 3 (raise_fd), so no stdio action
// replaces it before its dup2; stdin's dup2 runs first in case it is fd 3.
// A channel root starts suspended until its pidversion is read. Only fds 0-2
// (and the channel's fd 3) reach the child: Darwin closes the rest with
// CLOEXEC_DEFAULT, Linux with a closefrom action after the dup2 actions.
static int prepare_spawn(posix_spawnattr_t *attrs,
                         posix_spawn_file_actions_t *actions, int stdin_fd,
                         int channel_fd, int stderr_fd) {
  sigset_t defaults, mask;
  sigfillset(&defaults);
  sigemptyset(&mask);
#ifdef __APPLE__
  short flags = POSIX_SPAWN_CLOEXEC_DEFAULT |
                (channel_fd >= 0 ? POSIX_SPAWN_START_SUSPENDED : 0);
#else
  short flags = 0;
#endif
  int failed = posix_spawnattr_setflags(
      attrs, POSIX_SPAWN_SETSID | POSIX_SPAWN_SETSIGDEF |
                 POSIX_SPAWN_SETSIGMASK | flags);
  failed = failed || posix_spawnattr_setsigdefault(attrs, &defaults);
  failed = failed || posix_spawnattr_setsigmask(attrs, &mask);
  failed = failed ||
           (stdin_fd >= 0
                ? posix_spawn_file_actions_adddup2(actions, stdin_fd, 0)
                : posix_spawn_file_actions_addopen(actions, 0, "/dev/null",
                                                   O_RDONLY, 0));
  // dup2 clears CLOEXEC on fd 3 only; the daemon sets it again at startup.
  failed = failed ||
           (channel_fd >= 0 &&
            posix_spawn_file_actions_adddup2(actions, channel_fd, CHANNEL_FD));
  failed = failed || posix_spawn_file_actions_addopen(actions, 1, "/dev/null",
                                                      O_WRONLY, 0);
  failed = failed ||
           (stderr_fd >= 0
                ? posix_spawn_file_actions_adddup2(actions, stderr_fd, 2)
                : posix_spawn_file_actions_addopen(actions, 2, "/dev/null",
                                                   O_WRONLY, 0));
#ifndef __APPLE__
  failed = failed || posix_spawn_file_actions_addclosefrom_np(
                         actions, channel_fd >= 0 ? CHANNEL_FD + 1 : 3);
#endif
  return failed;
}

// Bounded private handoff. A failure leaves the child to fail its own
// bounded read; the handle is still returned because the child exists.
static void write_all(int fd, const char *data, size_t size) {
  int64_t deadline = now_ms() + DEADLINE_MS;
  size_t written = 0;
  while (written < size) {
    ssize_t n = write(fd, data + written, size - written);
    if (n > 0) {
      written += (size_t)n;
      continue;
    }
    if (n < 0 && errno == EINTR) continue;
    if (n < 0 && errno != EAGAIN) return;
    int64_t left = deadline - now_ms();
    if (left <= 0) return;
    struct pollfd ready = {fd, POLLOUT, 0};
    if (poll(&ready, 1, (int)left) < 0 && errno != EINTR) return;
  }
}

#ifdef __APPLE__
static void write_stdin(int fd, const char *data, size_t size) {
  write_all(fd, data, size);
}
#else
// Linux has no per-descriptor SIGPIPE opt-out: a write to a pipe the child
// closed raises SIGPIPE on this thread, whose disposition the host owns. It
// stays blocked for the write, and one raised by the write is consumed.
static void write_stdin(int fd, const char *data, size_t size) {
  sigset_t pipe_signal, pending, previous;
  sigemptyset(&pipe_signal);
  sigaddset(&pipe_signal, SIGPIPE);
  sigemptyset(&pending);
  sigpending(&pending);
  bool was_pending = sigismember(&pending, SIGPIPE) == 1;
  if (pthread_sigmask(SIG_BLOCK, &pipe_signal, &previous) != 0) return;
  write_all(fd, data, size);
  if (!was_pending) {
    sigemptyset(&pending);
    sigpending(&pending);
    if (sigismember(&pending, SIGPIPE) == 1) {
      struct timespec none = {0, 0};
      while (sigtimedwait(&pipe_signal, NULL, &none) == -1 && errno == EINTR) {
      }
    }
  }
  pthread_sigmask(SIG_SETMASK, &previous, NULL);
}
#endif

static bool open_pipe(int fds[2]) {
  if (pipe(fds) != 0) return false;
  bool ok = fcntl(fds[0], F_SETFD, FD_CLOEXEC) == 0 &&
            fcntl(fds[1], F_SETFD, FD_CLOEXEC) == 0 &&
#ifdef __APPLE__
            fcntl(fds[1], F_SETNOSIGPIPE, 1) == 0 &&
#endif
            fcntl(fds[1], F_SETFL, O_NONBLOCK) == 0;
  if (!ok) {
    close(fds[0]);
    close(fds[1]);
    fds[0] = fds[1] = -1;
  }
  return ok;
}

// Moves a CLOEXEC descriptor above CHANNEL_FD.
static bool raise_fd(int *fd) {
  if (*fd > CHANNEL_FD) return true;
  int moved = fcntl(*fd, F_DUPFD_CLOEXEC, CHANNEL_FD + 1);
  if (moved < 0) return false;
  close(*fd);
  *fd = moved;
  return true;
}

#ifdef __linux__
// A capture failure is optional: the caller falls back to /dev/null.
static bool open_stderr_capture(int fds[2]) {
  if (pipe2(fds, O_CLOEXEC) != 0) return false;
  if (!raise_fd(&fds[0]) || !raise_fd(&fds[1])) {
    close(fds[0]);
    close(fds[1]);
    fds[0] = fds[1] = -1;
    return false;
  }
  return true;
}
#endif

// fds[0] stays with the parent, nonblocking; fds[1] becomes the child's fd 3.
// Both ends are CLOEXEC, so no other spawn in this process inherits either.
static bool open_channel(int fds[2]) {
#ifdef __linux__
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, fds) != 0) return false;
#else
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, fds) != 0) return false;
#endif
  int on = 1;
  bool ok = fcntl(fds[0], F_SETFD, FD_CLOEXEC) == 0 &&
            fcntl(fds[1], F_SETFD, FD_CLOEXEC) == 0 &&
#ifdef __APPLE__
            setsockopt(fds[0], SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof on) == 0 &&
#else
            setsockopt(fds[0], SOL_SOCKET, SO_PASSCRED, &on, sizeof on) == 0 &&
            setsockopt(fds[1], SOL_SOCKET, SO_PASSCRED, &on, sizeof on) == 0 &&
            setsockopt(fds[0], SOL_SOCKET, SO_PASSPIDFD, &on, sizeof on) == 0 &&
            setsockopt(fds[1], SOL_SOCKET, SO_PASSPIDFD, &on, sizeof on) == 0 &&
#endif
            fcntl(fds[0], F_SETFL, O_NONBLOCK) == 0 && raise_fd(&fds[1]);
  if (!ok) {
    close(fds[0]);
    close(fds[1]);
    fds[0] = fds[1] = -1;
  }
  return ok;
}

#ifdef __linux__
static bool linux_probe_channel(void);

// Cache success per load: the fork/reap probe is not part of each channel poll.
// Ordinary spawn needs none of these facilities.
static bool require_linux_channel(napi_env env, instance *inst) {
  if (!inst->linux_channel_ready) inst->linux_channel_ready = linux_probe_channel();
  if (!inst->linux_channel_ready)
    throw_code(env, "ERR_OWNED_CHILD_CHANNEL_UNSUPPORTED",
               "Linux launcher channels require stale-sender pidfds and pidfs.");
  return inst->linux_channel_ready;
}
#endif

#ifdef __APPLE__
// The audit token of a live task names its pid and pidversion.
static bool task_pidversion(pid_t pid, int *version) {
  mach_port_t name = MACH_PORT_NULL;
  if (task_name_for_pid(mach_task_self(), pid, &name) != KERN_SUCCESS)
    return false;
  audit_token_t token;
  mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
  kern_return_t status =
      task_info(name, TASK_AUDIT_TOKEN, (task_info_t)&token, &count);
  mach_port_deallocate(mach_task_self(), name);
  if (status != KERN_SUCCESS || audit_token_to_pid(token) != pid) return false;
  *version = audit_token_to_pidversion(token);
  return true;
}
#endif

// A record whose handle cannot be delivered: roll the child back here.
static napi_value fail_undelivered(napi_env env, instance *inst,
                                   record *item) {
#ifdef __linux__
  if (item->launcher_end) {
    unlink_record(inst, item);
    throw_code(env, "ERR_OWNED_CHILD_CHANNEL", "Owned child channel is unavailable.");
    return NULL;
  }
#endif
  bool cleaned = rollback_blocking(item->pid);
  if (cleaned) unlink_record(inst, item);
  else close_channel(item);
  throw_code(env, cleaned ? "ERR_OWNED_CHILD_SPAWN" : "ERR_OWNED_CHILD_CLEANUP",
             cleaned ? "Owned child could not be started."
                     : "Owned child cleanup did not complete.");
  return NULL;
}

// Wraps a fresh record; on failure the child is rolled back here, since no
// handle can be returned for it.
static napi_value make_handle(napi_env env, instance *inst, record *item,
                              int stderr_fd) {
  napi_value handle, result;
  token *tok = malloc(sizeof *tok);
  bool ok = tok && napi_create_object(env, &handle) == napi_ok &&
            napi_type_tag_object(env, handle, &HANDLE_TAG) == napi_ok;
  if (ok) {
    tok->owner = inst;
    tok->serial = item->serial;
    ok = napi_wrap(env, handle, tok, finalize_token, NULL, NULL) == napi_ok;
    if (ok) tok = NULL;
  }
  ok = ok && napi_create_object(env, &result) == napi_ok &&
       napi_set_named_property(env, result, "handle", handle) == napi_ok &&
       napi_set_named_property(env, result, "pid", make_int(env, item->pid)) ==
           napi_ok;
  if (ok && stderr_fd >= 0)
    ok = napi_set_named_property(env, result, "stderr",
                                 make_int(env, stderr_fd)) == napi_ok;
  free(tok);
  if (ok) {
    item->delivered = true;
    return result;
  }
  if (stderr_fd >= 0) close(stderr_fd);
  return fail_undelivered(env, inst, item);
}

static napi_value spawn_record(napi_env env, napi_callback_info info,
                               bool channel) {
  size_t argc = 5;
  napi_value argv[5];
  void *data = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok ||
      (argc != 4 && argc != 5) || !data) {
    throw_code(env, "ERR_OWNED_CHILD_ARGUMENT", "Owned child call is invalid.");
    return NULL;
  }
  napi_valuetype stdin_type = napi_undefined;
  napi_typeof(env, argv[3], &stdin_type);
  bool capture_stderr = false;
  if (argc == 5 &&
      napi_get_value_bool(env, argv[4], &capture_stderr) != napi_ok) {
    throw_code(env, "ERR_OWNED_CHILD_ARGUMENT", "Owned child call is invalid.");
    return NULL;
  }
#ifndef __linux__
  capture_stderr = false;
#endif
  char *executable = copy_string(env, argv[0]);
  char **args = copy_vector(env, argv[1], 1);
  char **environment = copy_vector(env, argv[2], 0);
  char *input = stdin_type == napi_null ? NULL : copy_string(env, argv[3]);
  bool valid = executable && executable[0] == '/' && args && environment &&
               (stdin_type == napi_null || (input && strlen(input) <= MAX_STDIN_BYTES));
  for (char **at = environment; valid && *at; at++)
    valid = strchr(*at, '=') != NULL && **at != '=';
#ifdef __linux__
  if (valid && channel && !require_linux_channel(env, data)) {
    free(executable);
    free_vector(args);
    free_vector(environment);
    free(input);
    return NULL;
  }
#endif
  record *item = valid ? calloc(1, sizeof *item) : NULL;
  int fds[2] = {-1, -1};
  int pair[2] = {-1, -1};
  int stderr_pipe[2] = {-1, -1};
  pid_t pid = 0;
  int spawn_error = -1;
  int version = 0;
#ifdef __linux__
  int pidfd = -1;
  if (item) item->pidfd = -1;
#endif
  bool started = false;
  if (item && (!input || open_pipe(fds)) && (!channel || open_channel(pair))) {
#ifdef __linux__
    // Diagnostics must not consume descriptors needed for the handoff. A
    // capture failure leaves both ends absent and fd 2 mapped to /dev/null.
    if (capture_stderr) open_stderr_capture(stderr_pipe);
#endif
    posix_spawnattr_t attrs;
    posix_spawn_file_actions_t actions;
    if (posix_spawnattr_init(&attrs) == 0) {
      if (posix_spawn_file_actions_init(&actions) == 0) {
        if (!prepare_spawn(&attrs, &actions, fds[0], pair[1], stderr_pipe[1]))
          spawn_error =
              posix_spawn(&pid, executable, &actions, &attrs, args, environment);
        posix_spawn_file_actions_destroy(&actions);
      }
      posix_spawnattr_destroy(&attrs);
    }
    // The child end lives only in the child.
    if (pair[1] >= 0) close(pair[1]);
    if (stderr_pipe[1] >= 0) {
      close(stderr_pipe[1]);
      stderr_pipe[1] = -1;
    }
    if (fds[0] >= 0) close(fds[0]);
    // A channel root is read while still suspended, so even an immediate
    // exec changes its pidversion; peer evidence must match this one. It is
    // resumed before stdin is written and before any rollback, because
    // waitid(WEXITED) reports a stopped root as if it had exited.
    started = spawn_error == 0;
    if (started && channel) {
#ifdef __APPLE__
      bool captured = task_pidversion(pid, &version);
      started = kill(pid, SIGCONT) == 0 && captured;
#else
      // The unreaped child reserves the numeric PID while pidfd_open runs.
      pidfd = syscall(SYS_pidfd_open, pid, 0);
      struct stat identity;
      started = linux_pidfs(pidfd, &identity);
#endif
      if (!started) kill(pid, SIGKILL);
    }
    if (started && input) write_stdin(fds[1], input, strlen(input));
    if (fds[1] >= 0) close(fds[1]);
  } else if (fds[0] >= 0) {
    close(fds[0]);
    close(fds[1]);
  }
  if (stderr_pipe[1] >= 0) close(stderr_pipe[1]);
  free(executable);
  free_vector(args);
  free_vector(environment);
  free(input);
  if (spawn_error != 0 || pid <= 1) {
    if (pair[0] >= 0) close(pair[0]);
    if (stderr_pipe[0] >= 0) close(stderr_pipe[0]);
    free(item);
#ifdef __linux__
    if (valid && spawn_error > 0) {
      napi_value message, error, number;
      napi_create_string_utf8(env, "Owned child could not be started.",
                              NAPI_AUTO_LENGTH, &message);
      napi_create_error(env, NULL, message, &error);
      napi_create_string_utf8(env, "ERR_OWNED_CHILD_SPAWN", NAPI_AUTO_LENGTH,
                              &message);
      napi_set_named_property(env, error, "code", message);
      napi_create_int32(env, spawn_error, &number);
      napi_set_named_property(env, error, "errno", number);
      napi_throw(env, error);
    } else
#endif
      throw_code(env, valid ? "ERR_OWNED_CHILD_SPAWN" : "ERR_OWNED_CHILD_ARGUMENT",
                 valid ? "Owned child could not be started."
                       : "Owned child call is invalid.");
    return NULL;
  }
  instance *inst = data;
  item->serial = __atomic_add_fetch(&next_serial, 1, __ATOMIC_RELAXED);
  item->pid = pid;
  item->state = OWNED;
  item->channel = pair[0];
  item->pidversion = version;
#ifdef __linux__
  item->pidfd = pidfd;
  item->uid = getuid();
  item->gid = getgid();
#endif
  item->next = inst->head;
  inst->head = item;
  if (!started) {
    if (stderr_pipe[0] >= 0) close(stderr_pipe[0]);
    return fail_undelivered(env, inst, item);
  }
  return make_handle(env, inst, item, stderr_pipe[0]);
}

// spawn(executable, argv, envPairs, stdin | null) -> { handle, pid }
static napi_value spawn_child(napi_env env, napi_callback_info info) {
  return spawn_record(env, info, false);
}

// spawnChannel(executable, argv, envPairs, stdin | null) -> { handle, pid }
// As spawn, plus the launcher channel on the child's fd 3.
static napi_value spawn_channel(napi_env env, napi_callback_info info) {
  return spawn_record(env, info, true);
}

// observe(handle) -> { state: 'running' | 'lost' } | { state: 'exited', code, signal }
static napi_value observe(napi_env env, napi_callback_info info) {
  instance *inst;
  record *item = handle_arg(env, info, &inst);
  if (!item) return NULL;
  siginfo_t status;
  switch (inspect_root(item->pid, &status)) {
    case ROOT_RUNNING:
      return make_state(env, "running");
    case ROOT_LOST:
      return make_state(env, "lost");
    case ROOT_EXITED:
      break;
  }
  napi_value out = make_state(env, "exited");
  bool exited = status.si_code == CLD_EXITED;
  bool killed = status.si_code == CLD_KILLED || status.si_code == CLD_DUMPED;
  napi_set_named_property(env, out, "code",
                          exited ? make_int(env, status.si_status)
                                 : make_null(env));
  napi_set_named_property(env, out, "signal",
                          killed ? make_int(env, status.si_status)
                                 : make_null(env));
  return out;
}

static bool require_owned(napi_env env, record *item) {
  if (item->state == OWNED) return true;
  throw_code(env, "ERR_OWNED_CHILD_COMMITTED",
             "Owned child is committed and cannot be stopped.");
  return false;
}

static bool require_waitable(napi_env env, record *item, root_state *state) {
  *state = inspect_root(item->pid, NULL);
  if (*state != ROOT_LOST) return true;
  throw_code(env, "ERR_OWNED_CHILD_LOST", "Owned child ownership was lost.");
  return false;
}

// stopGroup(handle): SIGKILL to the owned group of an unreaped root.
static napi_value stop_group(napi_env env, napi_callback_info info) {
  instance *inst;
  record *item = handle_arg(env, info, &inst);
  root_state root;
  if (!item || !require_owned(env, item) || !require_waitable(env, item, &root))
    return NULL;
  if (!signal_group(item->pid)) {
    throw_code(env, "ERR_OWNED_CHILD_SIGNAL", "Owned child could not be signaled.");
    return NULL;
  }
  return make_bool(env, true);
}

// members(handle) -> live group members other than the root.
static napi_value members(napi_env env, napi_callback_info info) {
  instance *inst;
  record *item = handle_arg(env, info, &inst);
  root_state root;
  if (!item || !require_waitable(env, item, &root)) return NULL;
  int count = group_members(item->pid);
  if (count < 0) {
    throw_code(env, "ERR_OWNED_CHILD_ENUMERATION",
               "Owned child group could not be enumerated.");
    return NULL;
  }
  return make_int(env, count);
}

// release(handle) -> true once reaped; false while the root runs or, for an
// uncommitted handle, while its group has members. Only a stop releases an
// uncommitted handle, so Linux may signal its group here.
static napi_value release(napi_env env, napi_callback_info info) {
  instance *inst;
  record *item = handle_arg(env, info, &inst);
  root_state root;
  if (!item || !require_waitable(env, item, &root)) return NULL;
  if (root != ROOT_EXITED) return make_bool(env, false);
  if (item->state == OWNED) {
    int count = settled_members(item->pid);
    if (count < 0) {
      throw_code(env, "ERR_OWNED_CHILD_ENUMERATION",
                 "Owned child group could not be enumerated.");
      return NULL;
    }
    if (count > 0) return make_bool(env, false);
  }
  if (!reap(item->pid)) {
    throw_code(env, "ERR_OWNED_CHILD_LOST", "Owned child ownership was lost.");
    return NULL;
  }
  unlink_record(inst, item);
  return make_bool(env, true);
}

// commit(handle): drops kill authority; the root stays reapable. An exited
// root is refused: its surviving group must be rolled back, not disowned.
static napi_value commit(napi_env env, napi_callback_info info) {
  instance *inst;
  record *item = handle_arg(env, info, &inst);
  root_state root;
  if (!item || !require_owned(env, item) || !require_waitable(env, item, &root))
    return NULL;
  if (root == ROOT_EXITED) {
    throw_code(env, "ERR_OWNED_CHILD_EXITED", "Owned child exited before commit.");
    return NULL;
  }
  item->state = COMMITTED;
  return make_bool(env, true);
}

// rollbackSync(handle) -> true once the group is gone and the root reaped.
// Blocks up to the deadline; for host exit, where no timer can run.
static napi_value rollback_sync(napi_env env, napi_callback_info info) {
  instance *inst;
  record *item = handle_arg(env, info, &inst);
  if (!item || !require_owned(env, item)) return NULL;
  if (!rollback_blocking(item->pid)) return make_bool(env, false);
  unlink_record(inst, item);
  return make_bool(env, true);
}

// Only failed handle constructions: never touches another caller's delivered child.
static napi_value rollback_undelivered(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  void *data = NULL;
  if (napi_get_cb_info(env, info, &argc, NULL, NULL, &data) != napi_ok || !data)
    return NULL;
  instance *inst = data;
  bool complete = true;
  for (record *item = inst->head; item;) {
    record *next = item->next;
    if (!item->delivered && item->state == OWNED) {
      if (rollback_blocking(item->pid)) unlink_record(inst, item);
      else complete = false;
    }
    item = next;
  }
  return make_bool(env, complete);
}

// Resolves (handle, ...) for a channel call; `extra` arguments follow.
static record *channel_args(napi_env env, napi_callback_info info,
                            napi_value *extra, size_t count) {
  size_t argc = 3;
  napi_value argv[3];
  void *data = NULL;
  if (count > 2 ||
      napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok ||
      argc != count + 1 || !data) {
    throw_code(env, "ERR_OWNED_CHILD_ARGUMENT", "Owned child call is invalid.");
    return NULL;
  }
  record *item = resolve_handle(env, data, argv[0]);
  if (!item) return NULL;
  if (item->channel < 0) {
    throw_code(env, "ERR_OWNED_CHILD_CHANNEL",
               "Owned child channel is unavailable.");
    return NULL;
  }
  for (size_t n = 0; n < count; n++) extra[n] = argv[n + 1];
  return item;
}

static void channel_failed(napi_env env, record *item) {
  close_channel(item);
  throw_code(env, "ERR_OWNED_CHILD_CHANNEL",
             "Owned child channel is unavailable.");
}

#ifdef __linux__
// pidfs (Linux 6.9+) gives every process instance a stable inode shared by
// independently opened pidfds, including SCM_PIDFD. Anonymous pidfd inodes on
// older kernels cannot prove equality, so the channel has no fallback there.
static bool linux_pidfs(int fd, struct stat *identity) {
  struct statfs fs;
  return fd >= 0 && fstatfs(fd, &fs) == 0 && fs.f_type == PID_FS_MAGIC &&
         fstat(fd, identity) == 0;
}

static bool linux_sender(record *item, int sender) {
  struct stat expected, actual;
  return linux_pidfs(item->pidfd, &expected) && linux_pidfs(sender, &actual) &&
         expected.st_dev == actual.st_dev && expected.st_ino == actual.st_ino;
}

// pidfd is instance/liveness custody, not an exec generation or code identity.
static bool linux_live(record *item) {
  struct pollfd fd = {item->pidfd, POLLIN, 0};
  int result;
  do { result = poll(&fd, 1, 0); } while (result < 0 && errno == EINTR);
  return item->pidfd >= 0 && result == 0;
}

// SO_PEERCRED on a socketpair identifies its creator, not its writers. Every
// returned byte instead passes recvmsg's SCM_CREDENTIALS check. Linux splits
// stream receives at credential boundaries, even when payloads coalesce.
static ssize_t linux_receive(record *item, void *bytes, size_t size) {
  union {
    struct cmsghdr align;
    char bytes[CMSG_SPACE(sizeof(struct ucred)) + CMSG_SPACE(sizeof(int)) +
               CMSG_SPACE(sizeof(int) * 16)];
  } control;
  struct iovec vector = {bytes, size};
  struct msghdr msg = {0};
  msg.msg_iov = &vector;
  msg.msg_iovlen = 1;
  msg.msg_control = control.bytes;
  msg.msg_controllen = sizeof control.bytes;
  ssize_t n = recvmsg(item->channel, &msg, MSG_DONTWAIT | MSG_CMSG_CLOEXEC);
  if (n < 0) return n;
  bool valid = !(msg.msg_flags & (MSG_CTRUNC | MSG_TRUNC));
  unsigned credentials = 0, pidfds = 0;
  for (struct cmsghdr *c = CMSG_FIRSTHDR(&msg); c; c = CMSG_NXTHDR(&msg, c)) {
    size_t remaining = msg.msg_controllen - ((char *)c - (char *)msg.msg_control);
    if (c->cmsg_len < CMSG_LEN(0) || c->cmsg_len > remaining) {
      valid = false;
      break;
    }
    if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS) {
      // Even refused ancillary messages transfer descriptors: close all of them.
      size_t count = (c->cmsg_len - CMSG_LEN(0)) / sizeof(int);
      int *fds = (int *)CMSG_DATA(c);
      for (size_t i = 0; i < count; i++) close(fds[i]);
      valid = false;
    } else if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_PIDFD &&
               c->cmsg_len == CMSG_LEN(sizeof(int))) {
      int sender;
      memcpy(&sender, CMSG_DATA(c), sizeof sender);
      pidfds++;
      bool matches = linux_sender(item, sender);
      close(sender);
      valid = valid && matches;
    } else if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_CREDENTIALS &&
               c->cmsg_len == CMSG_LEN(sizeof(struct ucred))) {
      struct ucred cred;
      memcpy(&cred, CMSG_DATA(c), sizeof cred);
      credentials++;
      // Linux translates values into the receiver's PID/user namespaces.
      // Defaults are sender tgid and real uid/gid; explicit creds may use its
      // own pid and real/effective/saved ids. CAP_SYS_ADMIN in the active PID
      // namespace's owning user ns / CAP_SETUID or CAP_SETGID in the sender's
      // user ns permit overrides; SCM_PIDFD follows that credential pid.
      // Such capable impersonation is outside L1, not prevented by pidfd.
      valid = valid && cred.pid == item->pid && cred.uid == item->uid &&
              cred.gid == item->gid;
    } else {
      valid = false;
    }
  }
  if (n > 0 && (!valid || credentials != 1 || pidfds != 1)) {
    errno = EACCES;
    return -1;
  }
  return n;
}

// SCM_PIDFD must survive reaping, not just exit (upstream Linux 6.17+).
// Hold the expected pidfd before waitpid releases the numeric PID reservation.
static bool linux_probe_channel(void) {
  int pair[2] = {-1, -1};
  if (!open_channel(pair)) return false;
  pid_t child = fork();
  if (child == 0) {
    // Only async-signal-safe calls after fork in the multithreaded Node host.
    close(pair[0]);
    ssize_t n;
    do { n = write(pair[1], "!", 1); } while (n < 0 && errno == EINTR);
    _exit(n == 1 ? 0 : 1);
  }
  close(pair[1]);
  bool available = false;
  if (child > 0) {
    record peer = {0};
    peer.channel = pair[0];
    peer.pid = child;
    peer.uid = getuid();
    peer.gid = getgid();
    peer.pidfd = syscall(SYS_pidfd_open, child, 0);
    int status = 0;
    pid_t reaped;
    do { reaped = waitpid(child, &status, 0); } while (reaped < 0 && errno == EINTR);
    if (reaped == child && WIFEXITED(status) && WEXITSTATUS(status) == 0) {
      char byte = 0;
      ssize_t n;
      do { n = linux_receive(&peer, &byte, 1); } while (n < 0 && errno == EINTR);
      available = n == 1 && byte == '!';
    }
    if (peer.pidfd >= 0) close(peer.pidfd);
  }
  close(pair[0]);
  return available;
}

static napi_value channel_peer(napi_env env, napi_callback_info info) {
  record *item = channel_args(env, info, NULL, 0);
  if (!item) return NULL;
  if (!linux_live(item)) return make_state(env, "refused");
  if (!item->received) return make_state(env, "refused");
  napi_value out = make_state(env, "connected");
  napi_set_named_property(env, out, "pid", make_int(env, item->pid));
  napi_set_named_property(env, out, "uid", make_int(env, item->uid));
  napi_set_named_property(env, out, "gid", make_int(env, item->gid));
  return out;
}


// L2 pins the observed ELF inode, not a pathname later reopened for hashing.
// procfs and pidfd are bracketed to bind /proc observations to L1's instance.
typedef struct linux_image {
  int proc;
  int executable;
  struct stat file;
  pid_t parent;
  pid_t local_parent;
  char start[32];
  char boot[64];
  char command[MAX_STRING_BYTES];
  size_t command_size;
} linux_image;

static void linux_image_close(record *item) {
  linux_image *image = item->image;
  item->image = NULL;
  if (!image) return;
  if (image->proc >= 0) close(image->proc);
  if (image->executable >= 0) close(image->executable);
  free(image);
}

static ssize_t linux_read_at(int directory, const char *name, char *out, size_t capacity) {
  int fd = openat(directory, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return -1;
  size_t total = 0;
  while (total < capacity) {
    ssize_t n = read(fd, out + total, capacity - total);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) { close(fd); return -1; }
    if (!n) break;
    total += (size_t)n;
  }
  close(fd);
  if (total == capacity) return -1;
  out[total] = 0;
  return (ssize_t)total;
}

static bool linux_process_stat(int proc, pid_t *parent, char start[32]) {
  char bytes[8192];
  if (linux_read_at(proc, "stat", bytes, sizeof bytes) <= 0) return false;
  // comm may contain spaces and ')'; fields start after its final ')'.
  char *end = strrchr(bytes, ')');
  if (!end || end[1] != ' ') return false;
  char *save = NULL, *part = strtok_r(end + 2, " ", &save);
  for (int field = 3; part; field++, part = strtok_r(NULL, " ", &save)) {
    if (field == 3 && (!strcmp(part, "Z") || !strcmp(part, "X"))) return false;
    if (field == 4) {
      char *tail = NULL;
      long value = strtol(part, &tail, 10);
      if (!tail || *tail || value <= 1 || value > INT32_MAX) return false;
      *parent = (pid_t)value;
    }
    if (field == 22) {
      size_t n = strlen(part);
      if (!n || n >= 32 || strspn(part, "0123456789") != n || !strcmp(part, "0")) return false;
      memcpy(start, part, n + 1);
      return true;
    }
  }
  return false;
}

static bool linux_file_same(const struct stat *a, const struct stat *b) {
  return S_ISREG(a->st_mode) && S_ISREG(b->st_mode) && a->st_nlink && b->st_nlink &&
    a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_size == b->st_size &&
    a->st_mode == b->st_mode && a->st_uid == b->st_uid && a->st_gid == b->st_gid &&
    a->st_mtim.tv_sec == b->st_mtim.tv_sec && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec &&
    a->st_ctim.tv_sec == b->st_ctim.tv_sec && a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
}

// Detect disconnects even when no reader has observed EOF yet. Do not consume
// queued bytes here: L1 still owns sender attribution and final-byte draining.
static bool linux_image_channel_live(record *item) {
  if (item->channel < 0 || item->channel_eof) return false;
  struct pollfd fd = {item->channel, POLLRDHUP, 0};
  int result;
  do { result = poll(&fd, 1, 0); } while (result < 0 && errno == EINTR);
  return result == 0;
}

static bool linux_image_current(record *item) {
  linux_image *image = item->image;
  if (!image || !linux_image_channel_live(item) || !item->received || !linux_live(item) ||
      getppid() != image->local_parent) return false;
  struct stat held, observed;
  pid_t parent = 0;
  char start[32], command[MAX_STRING_BYTES];
  ssize_t n = linux_read_at(image->proc, "cmdline", command, sizeof command);
  bool valid = n > 0 && (size_t)n == image->command_size &&
    !memcmp(command, image->command, (size_t)n) &&
    linux_process_stat(image->proc, &parent, start) && parent == image->parent &&
    !strcmp(start, image->start) &&
    fstat(image->executable, &held) == 0 &&
    fstatat(image->proc, "exe", &observed, 0) == 0 &&
    linux_file_same(&image->file, &held) && linux_file_same(&held, &observed);
  // starttime/pidfd survives exec: an away-and-back exec is NOT detected.
  return valid && linux_live(item) && linux_image_channel_live(item);
}

static napi_value linux_migration_image(napi_env env, napi_callback_info info) {
  record *item = channel_args(env, info, NULL, 0);
  if (!item) return NULL;
  if (item->image_taken || item->channel_eof || !item->received || !linux_live(item)) return make_state(env, "refused");
  item->image_taken = true;
  linux_image *image = calloc(1, sizeof *image);
  if (!image) return make_state(env, "refused");
  image->proc = image->executable = -1;
  item->image = image;
  image->local_parent = getppid();
  char name[64];
  snprintf(name, sizeof name, "/proc/%d", item->pid);
  image->proc = open(name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct statfs fs;
  int peer = syscall(SYS_pidfd_open, item->pid, 0);
  bool valid = image->proc >= 0 && fstatfs(image->proc, &fs) == 0 &&
    fs.f_type == 0x9fa0 && linux_sender(item, peer) && linux_live(item);
  if (peer >= 0) close(peer);
  if (valid) image->executable = openat(image->proc, "exe", O_RDONLY | O_CLOEXEC);
  unsigned char magic[4];
  valid = valid && image->executable >= 0 &&
    pread(image->executable, magic, sizeof magic, 0) == sizeof magic &&
    !memcmp(magic, "\177ELF", sizeof magic) &&
    fstat(image->executable, &image->file) == 0 &&
    linux_process_stat(image->proc, &image->parent, image->start);
  ssize_t n = valid ? linux_read_at(image->proc, "cmdline", image->command, sizeof image->command) : -1;
  valid = valid && n > 1 && image->command[n - 1] == 0;
  if (valid) image->command_size = (size_t)n;
  ssize_t boot = valid ? linux_read_at(AT_FDCWD, "/proc/sys/kernel/random/boot_id", image->boot, sizeof image->boot) : -1;
  if (boot == 37 && image->boot[36] == '\n') image->boot[36] = 0;
  else valid = false;
  if (!valid || !linux_image_current(item)) {
    linux_image_close(item);
    return make_state(env, "refused");
  }
  napi_value out = make_state(env, "captured"), text, command;
  napi_set_named_property(env, out, "pid", make_int(env, item->pid));
  napi_set_named_property(env, out, "parentPid", make_int(env, image->parent));
  napi_set_named_property(env, out, "localPid", make_int(env, getpid()));
  napi_set_named_property(env, out, "localParentPid", make_int(env, image->local_parent));
  napi_set_named_property(env, out, "fd", make_int(env, image->executable));
  napi_create_string_utf8(env, image->start, NAPI_AUTO_LENGTH, &text);
  napi_set_named_property(env, out, "startTime", text);
  napi_create_string_utf8(env, image->boot, NAPI_AUTO_LENGTH, &text);
  napi_set_named_property(env, out, "bootId", text);
  snprintf(name, sizeof name, "%llu:%llu", (unsigned long long)image->file.st_dev, (unsigned long long)image->file.st_ino);
  napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &text);
  napi_set_named_property(env, out, "fileId", text);
  napi_create_string_utf8(env, item->launcher_end ? "launcher" : "daemon", NAPI_AUTO_LENGTH, &text);
  napi_set_named_property(env, out, "role", text);
  napi_create_buffer_copy(env, image->command_size, image->command, NULL, &command);
  napi_set_named_property(env, out, "command", command);
  return out;
}

static napi_value linux_migration_current(napi_env env, napi_callback_info info) {
  record *item = channel_args(env, info, NULL, 0);
  return item ? make_bool(env, linux_image_current(item)) : NULL;
}

static napi_value linux_migration_close(napi_env env, napi_callback_info info) {
  instance *inst;
  record *item = handle_arg(env, info, &inst);
  if (!item) return NULL;
  linux_image_close(item);
  return make_bool(env, true);
}

// Only a directly spawned child may adopt fd 3. The endpoint remains native,
// nonblocking and CLOEXEC; descendants writing an explicitly passed copy fail
// the receiver's per-receive credential comparison, including after bootstrap.
static napi_value connect_linux_launcher(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  void *data = NULL;
  int64_t expected = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, &data) != napi_ok ||
      argc != 1 || !data ||
      napi_get_value_int64(env, argv[0], &expected) != napi_ok ||
      expected <= 1 || expected > INT32_MAX) {
    throw_code(env, "ERR_OWNED_CHILD_ARGUMENT", "Owned child call is invalid.");
    return NULL;
  }
  if (!require_linux_channel(env, data)) return NULL;
  struct ucred creator;
  socklen_t length = sizeof creator;
  int type = 0;
  socklen_t type_length = sizeof type;
  int on = 1;
  int pidfd = -1, channel = -1;
  bool valid = getppid() == expected &&
      getsockopt(CHANNEL_FD, SOL_SOCKET, SO_TYPE, &type, &type_length) == 0 &&
      type == SOCK_STREAM &&
      getsockopt(CHANNEL_FD, SOL_SOCKET, SO_PEERCRED, &creator, &length) == 0 &&
      length == sizeof creator && creator.pid == expected &&
      creator.uid == getuid() && creator.gid == getgid();
  if (valid) pidfd = syscall(SYS_pidfd_open, (pid_t)expected, 0);
  struct stat identity;
  valid = valid && linux_pidfs(pidfd, &identity) && getppid() == expected;
  if (valid) channel = fcntl(CHANNEL_FD, F_DUPFD_CLOEXEC, CHANNEL_FD + 1);
  valid = valid && channel >= 0 &&
      fcntl(CHANNEL_FD, F_SETFD, FD_CLOEXEC) == 0 &&
      setsockopt(channel, SOL_SOCKET, SO_PASSCRED, &on, sizeof on) == 0 &&
      setsockopt(channel, SOL_SOCKET, SO_PASSPIDFD, &on, sizeof on) == 0 &&
      fcntl(channel, F_SETFL, O_NONBLOCK) == 0;
  record *item = valid ? calloc(1, sizeof *item) : NULL;
  if (!item) {
    if (channel >= 0) close(channel);
    if (pidfd >= 0) close(pidfd);
    throw_code(env, "ERR_OWNED_CHILD_CHANNEL", "Owned child channel is unavailable.");
    return NULL;
  }
  close(CHANNEL_FD);
  item->serial = __atomic_add_fetch(&next_serial, 1, __ATOMIC_RELAXED);
  item->pid = (pid_t)expected;
  item->pidfd = pidfd;
  item->uid = creator.uid;
  item->gid = creator.gid;
  item->channel = channel;
  item->launcher_end = true;
  item->state = COMMITTED;
  instance *inst = data;
  item->next = inst->head;
  inst->head = item;
  return make_handle(env, inst, item, -1);
}
#endif

// channelRead(handle, max) -> Buffer (empty while nothing is ready) | null at
// end of stream. A read error closes the channel.
static napi_value channel_read(napi_env env, napi_callback_info info) {
  napi_value extra[1];
  record *item = channel_args(env, info, extra, 1);
  if (!item) return NULL;
  int64_t max = 0;
  if (napi_get_value_int64(env, extra[0], &max) != napi_ok || max < 1 ||
      max > MAX_CHANNEL_BYTES) {
    throw_code(env, "ERR_OWNED_CHILD_ARGUMENT", "Owned child call is invalid.");
    return NULL;
  }
#ifdef __linux__
  if (item->channel_eof) return make_null(env);
#endif
  char bytes[MAX_CHANNEL_BYTES];
  ssize_t n;
  do {
#ifdef __APPLE__
    n = read(item->channel, bytes, (size_t)max);
#else
    n = linux_receive(item, bytes, (size_t)max);
#endif
  } while (n < 0 && errno == EINTR);
#ifdef __linux__
  // A co-holder cannot keep a dead peer's channel pending forever. Queued
  // attributed bytes are drained first, even after a custody query refuses.
  if (n < 0 && errno == EAGAIN && !linux_live(item)) {
    // The peer may have sent its last bytes between recvmsg and the death check.
    // Once dead it cannot send again: only a second empty receive proves EOF.
    do { n = linux_receive(item, bytes, (size_t)max); } while (n < 0 && errno == EINTR);
    if (n < 0 && errno == EAGAIN) n = 0;
  }
  if (n == 0) {
    item->channel_eof = true;
    if (item->pidfd >= 0) close(item->pidfd);
    item->pidfd = -1;
  }
#endif
  if (n == 0) return make_null(env);
  if (n < 0 && errno != EAGAIN) {
    channel_failed(env, item);
    return NULL;
  }
  size_t size = n > 0 ? (size_t)n : 0;
  item->received += size;
  napi_value out;
  if (napi_create_buffer_copy(env, size, bytes, NULL, &out) != napi_ok)
    return NULL;
  return out;
}

// channelWrite(handle, Uint8Array) -> bytes written; 0 while the peer is not
// reading. A write error, such as a closed peer, closes the channel.
static napi_value channel_write(napi_env env, napi_callback_info info) {
  napi_value extra[1];
  record *item = channel_args(env, info, extra, 1);
  if (!item) return NULL;
  bool typed = false;
  napi_typedarray_type type;
  size_t length = 0;
  void *bytes = NULL;
  if (napi_is_typedarray(env, extra[0], &typed) != napi_ok || !typed ||
      napi_get_typedarray_info(env, extra[0], &type, &length, &bytes, NULL,
                               NULL) != napi_ok ||
      type != napi_uint8_array || length < 1 || length > MAX_CHANNEL_BYTES) {
    throw_code(env, "ERR_OWNED_CHILD_ARGUMENT", "Owned child call is invalid.");
    return NULL;
  }
#ifdef __linux__
  if (!linux_live(item)) {
    channel_failed(env, item);
    return NULL;
  }
#endif
  ssize_t n;
  do {
#ifdef __APPLE__
    n = write(item->channel, bytes, length);
#else
    n = send(item->channel, bytes, length, MSG_NOSIGNAL);
#endif
  } while (n < 0 && errno == EINTR);
  if (n < 0 && errno != EAGAIN) {
    channel_failed(env, item);
    return NULL;
  }
  return make_int(env, n > 0 ? n : 0);
}

#ifdef __APPLE__
static napi_value refused(napi_env env, const char *reason) {
  napi_value out = make_state(env, "refused"), text;
  napi_create_string_utf8(env, reason, NAPI_AUTO_LENGTH, &text);
  napi_set_named_property(env, out, "reason", text);
  return out;
}

// channelPeer(handle) -> { state: 'peer', pid, pidversion, token } |
// { state: 'refused', reason }. The kernel reports the last process to use
// the peer end, so this is meaningful only after the peer's first frame. The
// unreaped root reserves its pid; the spawn-time pidversion refuses an exec.
static napi_value channel_peer(napi_env env, napi_callback_info info) {
  record *item = channel_args(env, info, NULL, 0);
  if (!item) return NULL;
  if (inspect_root(item->pid, NULL) != ROOT_RUNNING)
    return refused(env, "not_running");
  if (item->received == 0) return refused(env, "no_frame");
  audit_token_t token;
  socklen_t size = sizeof token;
  if (getsockopt(item->channel, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &size) !=
          0 ||
      size != sizeof token)
    return refused(env, "not_connected");
  if (audit_token_to_pid(token) != item->pid)
    return refused(env, "pid_mismatch");
  if (audit_token_to_pidversion(token) != item->pidversion)
    return refused(env, "pidversion_changed");
  napi_value out = make_state(env, "peer"), bytes;
  if (napi_create_buffer_copy(env, sizeof token, &token, NULL, &bytes) !=
      napi_ok)
    return NULL;
  napi_set_named_property(env, out, "pid", make_int(env, item->pid));
  napi_set_named_property(env, out, "pidversion",
                          make_int(env, item->pidversion));
  napi_set_named_property(env, out, "token", bytes);
  return out;
}

#endif

// channelClose(handle) -> true; idempotent. Reaping the root also closes it.
static napi_value channel_close(napi_env env, napi_callback_info info) {
  instance *inst;
  record *item = handle_arg(env, info, &inst);
  if (!item) return NULL;
  close_channel(item);
  return make_bool(env, true);
}

#ifdef __linux__
// Node's rename() can replace an independent empty directory. Linux publication
// needs renameat2(RENAME_NOREPLACE); never emulate it with a stat/rename pair.
static int migration_parent(char *path, char **leaf) {
  if (!path || path[0] != '/' || !path[1]) return -1;
  int parent = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (parent < 0) return -1;
  char *component = path + 1;
  for (;;) {
    char *slash = strchr(component, '/');
    if (slash) *slash = 0;
    if (!*component || !strcmp(component, ".") || !strcmp(component, "..")) break;
    if (!slash) { *leaf = component; return parent; }
    int child = openat(parent, component,
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(parent);
    if (child < 0) return -1;
    parent = child;
    component = slash + 1;
  }
  close(parent);
  return -1;
}

static napi_value migration_rename(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  char *from = NULL, *to = NULL, *identity = NULL, *from_name = NULL, *to_name = NULL;
  int from_parent = -1, to_parent = -1;
  bool ok = false;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 3) goto done;
  from = copy_string(env, args[0]);
  to = copy_string(env, args[1]);
  identity = copy_string(env, args[2]);
  if (!from || !to || !identity) goto done;
  from_parent = migration_parent(from, &from_name);
  to_parent = migration_parent(to, &to_name);
  struct stat source;
  char observed[96];
  if (from_parent < 0 || to_parent < 0 ||
      fstatat(from_parent, from_name, &source, AT_SYMLINK_NOFOLLOW) ||
      !S_ISDIR(source.st_mode) || source.st_uid != geteuid()) goto done;
  snprintf(observed, sizeof observed, "%llu:%llu",
    (unsigned long long)source.st_dev, (unsigned long long)source.st_ino);
  if (strcmp(observed, identity)) goto done;
  // RENAME_NOREPLACE = 1. ENOSYS/EINVAL/unsupported filesystem fail closed.
  ok = syscall(SYS_renameat2, from_parent, from_name, to_parent, to_name, 1) == 0;
done:
  if (from_parent >= 0) close(from_parent);
  if (to_parent >= 0) close(to_parent);
  free(from); free(to); free(identity);
  if (!ok) {
    throw_code(env, "ERR_MIGRATION_RENAME", "No-replace directory rename refused; preserve both trees and the journal.");
    return NULL;
  }
  return make_bool(env, true);
}
#endif

NAPI_MODULE_INIT() {
  instance *inst = calloc(1, sizeof *inst);
  if (!inst || napi_add_env_cleanup_hook(env, env_cleanup, inst) != napi_ok) {
    free(inst);
    throw_code(env, "ERR_OWNED_CHILD_LOAD", "Owned child support is unavailable.");
    return NULL;
  }
  napi_property_descriptor methods[] = {
      {"spawn", NULL, spawn_child, NULL, NULL, NULL, napi_enumerable, inst},
      {"observe", NULL, observe, NULL, NULL, NULL, napi_enumerable, inst},
      {"stopGroup", NULL, stop_group, NULL, NULL, NULL, napi_enumerable, inst},
      {"members", NULL, members, NULL, NULL, NULL, napi_enumerable, inst},
      {"release", NULL, release, NULL, NULL, NULL, napi_enumerable, inst},
      {"commit", NULL, commit, NULL, NULL, NULL, napi_enumerable, inst},
      {"rollbackSync", NULL, rollback_sync, NULL, NULL, NULL, napi_enumerable,
       inst},
      {"rollbackUndelivered", NULL, rollback_undelivered, NULL, NULL, NULL,
       napi_enumerable, inst},
      {"spawnChannel", NULL, spawn_channel, NULL, NULL, NULL, napi_enumerable,
       inst},
      {"channelRead", NULL, channel_read, NULL, NULL, NULL, napi_enumerable,
       inst},
      {"channelWrite", NULL, channel_write, NULL, NULL, NULL, napi_enumerable,
       inst},
      {"channelPeer", NULL, channel_peer, NULL, NULL, NULL, napi_enumerable,
       inst},
      {"channelClose", NULL, channel_close, NULL, NULL, NULL, napi_enumerable,
       inst},
#ifdef __linux__
      {"linuxMigrationImage", NULL, linux_migration_image, NULL, NULL, NULL, napi_enumerable, inst},
      {"linuxMigrationCurrent", NULL, linux_migration_current, NULL, NULL, NULL, napi_enumerable, inst},
      {"linuxMigrationClose", NULL, linux_migration_close, NULL, NULL, NULL, napi_enumerable, inst},
      {"migrationRenameNoReplace", NULL, migration_rename, NULL, NULL, NULL,
       napi_enumerable, inst},
      {"connectLinuxLauncher", NULL, connect_linux_launcher, NULL, NULL, NULL,
       napi_enumerable, inst},
#endif
  };
  // On failure the hook stays: it frees the empty instance at teardown.
  if (napi_define_properties(env, exports, sizeof methods / sizeof *methods,
                             methods) != napi_ok)
    return NULL;
#ifdef __linux__
  napi_set_named_property(env, exports, "stderrCapture", make_bool(env, true));
#endif
  return exports;
}
